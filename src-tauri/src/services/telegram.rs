//! Telegram Bot API: sending to the user's own chat, and (opt-in) long
//! polling for their messages. The bot token and chat id stay in the backend,
//! so neither the model nor the webview can send to any other chat.

use crate::data::{self, DataDir};
use crate::secrets;
use crate::shell::events;
use serde_json::{Value, json};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const API: &str = "https://api.telegram.org";
/// Telegram's limit for one message.
const MAX_MESSAGE_CHARS: usize = 4096;
const MAX_PARTS: usize = 4;
const POLL_SECONDS: u64 = 25;
const IDLE_WAIT: Duration = Duration::from_secs(10);
const ERROR_WAIT: Duration = Duration::from_secs(30);
/// Older messages are ignored, so nothing sent while JARVIS was closed runs later.
const MAX_AGE_SECONDS: i64 = 120;

struct Credentials {
    token: String,
    chat_id: i64,
}

fn credentials() -> Result<Credentials, String> {
    let read = |name| secrets::get(name).map_err(|error| error.to_string());
    let token = read("telegram_bot_token")?;
    let chat_id = read("telegram_chat_id")?;
    let (Some(token), Some(chat_id)) = (token, chat_id) else {
        return Err(
            "Telegram is not set up: add the bot token and your chat id in Settings › Services"
                .to_owned(),
        );
    };
    let chat_id = chat_id
        .parse()
        .map_err(|_| "the Telegram chat id must be a number".to_owned())?;
    // The token is part of the URL, so it must not be able to change it.
    if !token
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-'))
    {
        return Err("the Telegram bot token is not valid".to_owned());
    }
    Ok(Credentials { token, chat_id })
}

/// Splits on character boundaries into pieces Telegram accepts.
fn parts(text: &str) -> Vec<String> {
    text.chars()
        .collect::<Vec<_>>()
        .chunks(MAX_MESSAGE_CHARS)
        .map(|chunk| chunk.iter().collect())
        .collect()
}

/// Errors from `reqwest` include the URL, which contains the token.
fn safe(error: reqwest::Error) -> String {
    format!("Telegram is not reachable: {}", error.without_url())
}

fn check(body: &Value) -> Result<(), String> {
    if body["ok"].as_bool() == Some(true) {
        Ok(())
    } else {
        Err(format!(
            "Telegram refused the request: {}",
            body["description"].as_str().unwrap_or("unknown error")
        ))
    }
}

/// Sends a message to the configured chat.
pub async fn send(text: &str) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("the message is empty".to_owned());
    }
    let parts = parts(text);
    if parts.len() > MAX_PARTS {
        return Err("the message is too long for Telegram".to_owned());
    }
    let credentials = credentials()?;
    let client = super::http_client()?;
    for part in parts {
        let body: Value = client
            .post(format!("{API}/bot{}/sendMessage", credentials.token))
            .json(&json!({ "chat_id": credentials.chat_id, "text": part }))
            .send()
            .await
            .map_err(safe)?
            .json()
            .await
            .map_err(safe)?;
        check(&body)?;
    }
    Ok(())
}

/// The texts to act on in a `getUpdates` answer, and the next offset. Only
/// recent text messages from `chat_id` in a private chat count.
fn accept(body: &Value, chat_id: i64, now: i64, offset: i64) -> (Vec<String>, i64) {
    let mut texts = Vec::new();
    let mut next = offset;
    for update in body["result"].as_array().into_iter().flatten() {
        if let Some(id) = update["update_id"].as_i64() {
            next = next.max(id + 1);
        }
        let message = &update["message"];
        let from_owner = message["chat"]["id"].as_i64() == Some(chat_id)
            && message["chat"]["type"].as_str() == Some("private");
        let recent = message["date"]
            .as_i64()
            .is_some_and(|date| now - date <= MAX_AGE_SECONDS);
        if from_owner
            && recent
            && let Some(text) = message["text"].as_str()
        {
            texts.push(text.to_owned());
        }
    }
    (texts, next)
}

fn remote_enabled(dir: &DataDir) -> bool {
    matches!(
        data::read(&dir.0, "settings"),
        Ok(Some(settings)) if settings["telegramRemote"].as_bool() == Some(true)
    )
}

fn poll(
    client: &reqwest::blocking::Client,
    credentials: &Credentials,
    offset: i64,
) -> Result<(Vec<String>, i64), String> {
    let body: Value = client
        .get(format!("{API}/bot{}/getUpdates", credentials.token))
        .query(&[("offset", offset), ("timeout", POLL_SECONDS as i64)])
        .send()
        .map_err(safe)?
        .json()
        .map_err(safe)?;
    check(&body)?;
    let now = crate::reminders::now_ms() / 1000;
    Ok(accept(&body, credentials.chat_id, now, offset))
}

/// Polls while remote control is on in Settings and Telegram is set up. It
/// runs in Rust so it keeps working while the window is hidden.
pub fn spawn_listener(app: AppHandle, dir: DataDir) {
    std::thread::spawn(move || {
        let client = match reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(POLL_SECONDS + 10))
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                log::warn!("Telegram listener not started: {error}");
                return;
            }
        };
        let mut offset = 0;
        loop {
            // The setting is read first, so the Keychain is untouched while off.
            let credentials = remote_enabled(&dir).then(credentials);
            let Some(Ok(credentials)) = credentials else {
                std::thread::sleep(IDLE_WAIT);
                continue;
            };
            match poll(&client, &credentials, offset) {
                Ok((texts, next)) => {
                    offset = next;
                    // Remote control may have been turned off during the long poll.
                    if remote_enabled(&dir) {
                        for text in texts {
                            let _ = app.emit(events::TELEGRAM_MESSAGE, text);
                        }
                    }
                }
                Err(error) => {
                    log::warn!("{error}");
                    std::thread::sleep(ERROR_WAIT);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update(id: i64, chat: i64, kind: &str, date: i64) -> Value {
        json!({ "update_id": id, "message": {
            "chat": { "id": chat, "type": kind }, "date": date, "text": format!("m{id}") } })
    }

    #[test]
    fn accepts_only_recent_private_messages_from_the_owner() {
        let body = json!({ "result": [
            update(1, 42, "private", 1000),
            update(2, 7, "private", 1000),
            update(3, 42, "group", 1000),
            update(4, 42, "private", 10),
        ] });
        let (texts, next) = accept(&body, 42, 1010, 0);
        assert_eq!(texts, ["m1"]);
        assert_eq!(next, 5);
    }

    #[test]
    fn splits_long_messages_on_character_boundaries() {
        let text = "ñ".repeat(MAX_MESSAGE_CHARS + 1);
        let pieces = parts(&text);
        assert_eq!(pieces.len(), 2);
        assert_eq!(pieces[1], "ñ");
    }
}
