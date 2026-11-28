//! OAuth sign-in for Google and Spotify: authorization code with PKCE and a
//! loopback redirect. The user brings their own OAuth client, entered in
//! Settings. Refresh tokens stay in the OS credential store; the webview only
//! receives short-lived access tokens.
//!
//! Spotify has one account, handled here. Google has several, kept by
//! `google_accounts.rs` on top of [`authorize`] and [`refresh`].

use crate::secrets;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use url::Url;

const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(180);
/// Spotify requires the redirect URI to be registered, so the port is fixed.
/// Google accepts any loopback port for desktop clients.
pub const SPOTIFY_REDIRECT_PORT: u16 = 43821;
/// Access tokens are renewed this long before they expire.
const EXPIRY_MARGIN: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Google,
    Spotify,
}

struct Config {
    name: &'static str,
    auth_url: &'static str,
    token_url: &'static str,
    scopes: &'static str,
    client_id_secret: &'static str,
    /// Google requires the (not really secret) client secret of desktop clients.
    client_secret_secret: Option<&'static str>,
    port: u16,
}

impl Provider {
    const fn config(self) -> Config {
        match self {
            Self::Google => Config {
                name: "Google",
                auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
                token_url: "https://oauth2.googleapis.com/token",
                scopes: "https://www.googleapis.com/auth/gmail.readonly \
                         https://www.googleapis.com/auth/gmail.send \
                         https://www.googleapis.com/auth/calendar.events",
                client_id_secret: "google_client_id",
                client_secret_secret: Some("google_client_secret"),
                port: 0,
            },
            Self::Spotify => Config {
                name: "Spotify",
                auth_url: "https://accounts.spotify.com/authorize",
                token_url: "https://accounts.spotify.com/api/token",
                scopes: "user-read-playback-state user-modify-playback-state \
                         user-read-currently-playing",
                client_id_secret: "spotify_client_id",
                client_secret_secret: None,
                port: SPOTIFY_REDIRECT_PORT,
            },
        }
    }
}

/// Where Spotify's refresh token is stored, and its key in the token cache.
const SPOTIFY_TOKEN: &str = "spotify_refresh_token";

#[derive(Debug, thiserror::Error)]
pub enum OAuthError {
    #[error("{0} is not set up: add its OAuth client in Settings › Services")]
    NotConfigured(&'static str),
    #[error("{0} is not connected: connect it in Settings › Services")]
    NotConnected(&'static str),
    #[error("Google account {0} is not connected anymore: reconnect it in Settings › Services")]
    AccountNotConnected(String),
    #[error("{0}")]
    Failed(String),
    #[error("{0}")]
    Secret(#[from] secrets::SecretError),
}

impl Serialize for OAuthError {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub(crate) type Result<T> = std::result::Result<T, OAuthError>;

pub(crate) fn failed(message: impl Into<String>) -> OAuthError {
    OAuthError::Failed(message.into())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub configured: bool,
    pub connected: bool,
}

/// Access tokens kept in memory until they expire, one per refresh token
/// (keyed by its name in the credential store).
#[derive(Default)]
pub struct TokenCache(Mutex<HashMap<String, (String, Instant)>>);

impl TokenCache {
    pub(crate) fn get(&self, key: &str) -> Option<String> {
        let cache = self.0.lock().ok()?;
        let (token, expires) = cache.get(key)?;
        (Instant::now() < *expires).then(|| token.clone())
    }

    pub(crate) fn put(&self, key: &str, token: &str, lifetime: Duration) {
        if let Ok(mut cache) = self.0.lock() {
            let expires = Instant::now() + lifetime.saturating_sub(EXPIRY_MARGIN);
            cache.insert(key.to_owned(), (token.to_owned(), expires));
        }
    }

    pub(crate) fn forget(&self, key: &str) {
        if let Ok(mut cache) = self.0.lock() {
            cache.remove(key);
        }
    }
}

struct Client {
    id: String,
    secret: Option<String>,
}

fn client(config: &Config) -> Result<Client> {
    let missing = || OAuthError::NotConfigured(config.name);
    let id = secrets::get(config.client_id_secret)?.ok_or_else(missing)?;
    let secret = match config.client_secret_secret {
        Some(name) => Some(secrets::get(name)?.ok_or_else(missing)?),
        None => None,
    };
    Ok(Client { id, secret })
}

pub fn spotify_status() -> Result<Status> {
    let configured = match client(&Provider::Spotify.config()) {
        Ok(_) => true,
        Err(OAuthError::NotConfigured(_)) => false,
        Err(error) => return Err(error),
    };
    Ok(Status {
        configured,
        connected: secrets::get(SPOTIFY_TOKEN)?.is_some(),
    })
}

pub fn spotify_disconnect(cache: &TokenCache) -> Result<()> {
    cache.forget(SPOTIFY_TOKEN);
    Ok(secrets::delete(SPOTIFY_TOKEN)?)
}

fn random_token() -> Result<String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|error| failed(format!("no random data: {error}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn authorization_url(
    config: &Config,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    verifier: &str,
    login_hint: Option<&str>,
) -> Result<Url> {
    let mut url = Url::parse(config.auth_url).map_err(|error| failed(error.to_string()))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", config.scopes)
        .append_pair("state", state)
        .append_pair("code_challenge", &challenge(verifier))
        .append_pair("code_challenge_method", "S256");
    if config.client_secret_secret.is_some() {
        // Google only returns a refresh token when asked like this.
        // `select_account` lets the user add an account other than the one
        // already signed in to the browser.
        url.query_pairs_mut()
            .append_pair("access_type", "offline")
            .append_pair("prompt", "select_account consent");
    }
    if let Some(email) = login_hint {
        url.query_pairs_mut().append_pair("login_hint", email);
    }
    Ok(url)
}

/// What the browser's redirect request means.
#[derive(Debug, PartialEq, Eq)]
enum Callback {
    Code(String),
    Denied(String),
    /// Not our redirect (a favicon request, or a forged one with a wrong state).
    Ignore,
}

fn parse_callback(request_line: &str, state: &str) -> Callback {
    let target = request_line.split_whitespace().nth(1).unwrap_or_default();
    let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
        return Callback::Ignore;
    };
    let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
    if url.path() != "/callback" || query.get("state").map(String::as_str) != Some(state) {
        return Callback::Ignore;
    }
    match (query.get("code"), query.get("error")) {
        (Some(code), _) => Callback::Code(code.clone()),
        (None, Some(error)) => Callback::Denied(error.clone()),
        _ => Callback::Ignore,
    }
}

fn answer(stream: &mut TcpStream, status: &str, message: &str) {
    let body = format!("<!doctype html><meta charset=\"utf-8\"><p>{message}</p>");
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

/// Waits for the browser to come back with the authorization code. Blocking.
fn wait_for_code(listener: &TcpListener, state: &str, timeout: Duration) -> Result<String> {
    listener
        .set_nonblocking(true)
        .map_err(|error| failed(error.to_string()))?;
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(error) => return Err(failed(error.to_string())),
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let mut buffer = [0; 8192];
        let Ok(read) = stream.read(&mut buffer) else {
            continue;
        };
        let request = String::from_utf8_lossy(&buffer[..read]);
        match parse_callback(request.lines().next().unwrap_or_default(), state) {
            Callback::Code(code) => {
                answer(
                    &mut stream,
                    "200 OK",
                    "JARVIS is connecting. You can close this tab.",
                );
                return Ok(code);
            }
            Callback::Denied(reason) => {
                answer(
                    &mut stream,
                    "200 OK",
                    "Sign-in was cancelled. You can close this tab.",
                );
                return Err(failed(format!("sign-in was not completed: {reason}")));
            }
            Callback::Ignore => answer(&mut stream, "404 Not Found", "Not found."),
        }
    }
    Err(failed("sign-in timed out"))
}

async fn token_request(config: &Config, mut form: Vec<(&str, String)>) -> Result<Value> {
    let client = client(config)?;
    form.push(("client_id", client.id));
    if let Some(secret) = client.secret {
        form.push(("client_secret", secret));
    }
    let transport = |error: reqwest::Error| {
        failed(format!(
            "{} is not reachable: {}",
            config.name,
            error.without_url()
        ))
    };
    let response = super::http_client()
        .map_err(failed)?
        .post(config.token_url)
        .form(&form)
        .send()
        .await
        .map_err(transport)?;
    let status = response.status();
    let body: Value = response.json().await.map_err(transport)?;
    if status.is_success() {
        return Ok(body);
    }
    if body["error"].as_str() == Some("invalid_grant") {
        // The user revoked access or the token expired for good.
        return Err(OAuthError::NotConnected(config.name));
    }
    let reason = body["error_description"]
        .as_str()
        .or_else(|| body["error"].as_str())
        .unwrap_or("unknown error");
    Err(failed(format!("{} sign-in failed: {reason}", config.name)))
}

fn lifetime(body: &Value) -> Duration {
    Duration::from_secs(body["expires_in"].as_u64().unwrap_or(0))
}

/// The permissions in a token answer. With Google's per-permission consent
/// they can be fewer than were asked for. `None` when the answer omits them.
fn granted_scopes(body: &Value) -> Option<Vec<String>> {
    body["scope"]
        .as_str()
        .map(|scopes| scopes.split_whitespace().map(str::to_owned).collect())
}

/// What a completed sign-in returns.
pub(crate) struct SignIn {
    pub access_token: String,
    pub refresh_token: String,
    pub lifetime: Duration,
    pub scopes: Vec<String>,
}

/// Runs the browser sign-in and returns the tokens without storing them.
/// `open_browser` shows the provider's consent page.
pub(crate) async fn authorize(
    provider: Provider,
    login_hint: Option<&str>,
    open_browser: impl FnOnce(&str) -> std::result::Result<(), String>,
) -> Result<SignIn> {
    let config = provider.config();
    let client_id = client(&config)?.id;
    let listener = TcpListener::bind(("127.0.0.1", config.port)).map_err(|error| {
        failed(format!(
            "could not listen for the sign-in on port {}: {error}",
            config.port
        ))
    })?;
    let port = listener
        .local_addr()
        .map_err(|error| failed(error.to_string()))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let state = random_token()?;
    let verifier = random_token()?;
    let url = authorization_url(
        &config,
        &client_id,
        &redirect_uri,
        &state,
        &verifier,
        login_hint,
    )?;
    open_browser(url.as_str()).map_err(failed)?;

    let code = tauri::async_runtime::spawn_blocking(move || {
        wait_for_code(&listener, &state, SIGN_IN_TIMEOUT)
    })
    .await
    .map_err(|error| failed(error.to_string()))??;

    let body = token_request(
        &config,
        vec![
            ("grant_type", "authorization_code".to_owned()),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
        ],
    )
    .await?;
    let (Some(access), Some(refresh)) = (
        body["access_token"].as_str(),
        body["refresh_token"].as_str(),
    ) else {
        return Err(failed(format!(
            "{} did not return the expected tokens",
            config.name
        )));
    };
    Ok(SignIn {
        access_token: access.to_owned(),
        refresh_token: refresh.to_owned(),
        lifetime: lifetime(&body),
        scopes: granted_scopes(&body).unwrap_or_default(),
    })
}

/// A renewed access token.
pub(crate) struct Renewal {
    pub access_token: String,
    /// Set when the provider replaced the refresh token.
    pub refresh_token: Option<String>,
    pub lifetime: Duration,
    pub scopes: Option<Vec<String>>,
}

pub(crate) async fn refresh(provider: Provider, refresh_token: &str) -> Result<Renewal> {
    let config = provider.config();
    let body = token_request(
        &config,
        vec![
            ("grant_type", "refresh_token".to_owned()),
            ("refresh_token", refresh_token.to_owned()),
        ],
    )
    .await?;
    let Some(access) = body["access_token"].as_str() else {
        return Err(failed(format!(
            "{} did not return an access token",
            config.name
        )));
    };
    Ok(Renewal {
        access_token: access.to_owned(),
        refresh_token: body["refresh_token"].as_str().map(str::to_owned),
        lifetime: lifetime(&body),
        scopes: granted_scopes(&body),
    })
}

pub async fn spotify_connect(
    cache: &TokenCache,
    open_browser: impl FnOnce(&str) -> std::result::Result<(), String>,
) -> Result<()> {
    let signed_in = authorize(Provider::Spotify, None, open_browser).await?;
    secrets::set(SPOTIFY_TOKEN, &signed_in.refresh_token)?;
    cache.put(SPOTIFY_TOKEN, &signed_in.access_token, signed_in.lifetime);
    Ok(())
}

/// A valid Spotify access token, renewed with the refresh token when needed.
pub async fn spotify_access_token(cache: &TokenCache) -> Result<String> {
    if let Some(token) = cache.get(SPOTIFY_TOKEN) {
        return Ok(token);
    }
    let stored = secrets::get(SPOTIFY_TOKEN)?.ok_or(OAuthError::NotConnected("Spotify"))?;
    let renewed = refresh(Provider::Spotify, &stored).await?;
    // Spotify replaces the refresh token now and then.
    if let Some(rotated) = &renewed.refresh_token {
        secrets::set(SPOTIFY_TOKEN, rotated)?;
    }
    cache.put(SPOTIFY_TOKEN, &renewed.access_token, renewed.lifetime);
    Ok(renewed.access_token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_matches_the_pkce_example() {
        // From RFC 7636, appendix B.
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn authorization_url_carries_state_and_pkce() {
        let config = Provider::Google.config();
        let redirect = "http://127.0.0.1:1/callback";
        let url =
            authorization_url(&config, "id", redirect, "s", "v", Some("a@b.test")).expect("url");
        let query = url.query().unwrap_or_default();
        for expected in [
            "state=s",
            "code_challenge_method=S256",
            "access_type=offline",
            "prompt=select_account+consent",
            "login_hint=a%40b.test",
        ] {
            assert!(query.contains(expected), "{expected}");
        }
        assert!(!query.contains("code_verifier"));
    }

    #[test]
    fn reads_the_permissions_that_were_granted() {
        let body = serde_json::json!({ "scope": "a  b" });
        assert_eq!(granted_scopes(&body), Some(vec!["a".into(), "b".into()]));
        assert_eq!(granted_scopes(&serde_json::json!({})), None);
    }

    #[test]
    fn keeps_a_token_per_account() {
        let cache = TokenCache::default();
        cache.put("one", "first", Duration::from_secs(600));
        cache.put("two", "second", Duration::from_secs(600));
        cache.put("short", "expired", EXPIRY_MARGIN);
        cache.forget("one");
        assert_eq!(cache.get("one"), None);
        assert_eq!(cache.get("two").as_deref(), Some("second"));
        assert_eq!(cache.get("short"), None);
    }

    #[test]
    fn callback_requires_the_matching_state() {
        let code = |line: &str| parse_callback(line, "good");
        assert_eq!(
            code("GET /callback?code=abc&state=good HTTP/1.1"),
            Callback::Code("abc".into())
        );
        assert_eq!(
            code("GET /callback?code=abc&state=bad HTTP/1.1"),
            Callback::Ignore
        );
        assert_eq!(code("GET /favicon.ico HTTP/1.1"), Callback::Ignore);
        assert_eq!(
            code("GET /callback?error=access_denied&state=good HTTP/1.1"),
            Callback::Denied("access_denied".into())
        );
    }

    #[test]
    fn waits_through_unrelated_requests_for_the_code() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let address = listener.local_addr().expect("address");
        let browser = std::thread::spawn(move || {
            for target in ["/favicon.ico", "/callback?code=xyz&state=s"] {
                let mut stream = TcpStream::connect(address).expect("connect");
                write!(stream, "GET {target} HTTP/1.1\r\n\r\n").expect("write");
                let mut reply = String::new();
                let _ = stream.read_to_string(&mut reply);
            }
        });
        let code = wait_for_code(&listener, "s", Duration::from_secs(5)).expect("code");
        assert_eq!(code, "xyz");
        browser.join().expect("join");
    }
}
