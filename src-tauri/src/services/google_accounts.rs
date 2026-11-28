//! The connected Google accounts. Their list lives in `google-accounts.json`
//! in the app data folder and is written only here; each refresh token is a
//! separate entry in the OS credential store. The email address comes from
//! Google, never from the webview, so an account cannot be mislabelled.

use crate::data::{self, DataDir};
use crate::secrets;
use crate::services::oauth::{self, OAuthError, Provider, Result, TokenCache, failed};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

const DOCUMENT: &str = "google-accounts";
pub const MAX_ACCOUNTS: usize = 5;
const MAX_ALIAS_CHARS: usize = 30;
const PROFILE_URL: &str = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const MAIL_READ: &str = "https://www.googleapis.com/auth/gmail.readonly";
const MAIL_SEND: &str = "https://www.googleapis.com/auth/gmail.send";
const CALENDAR: &str = "https://www.googleapis.com/auth/calendar.events";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Account {
    id: String,
    email: String,
    alias: Option<String>,
    /// Permissions the user granted.
    scopes: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Index {
    /// Account used for sending and creating when none is named.
    default_id: Option<String>,
    accounts: Vec<Account>,
}

/// An account as the webview sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub id: String,
    pub email: String,
    pub alias: Option<String>,
    pub is_default: bool,
    pub mail_read: bool,
    pub mail_send: bool,
    pub calendar: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    pub account: AccountView,
    /// `false` when an account that was already listed signed in again.
    pub is_new: bool,
}

fn too_many() -> OAuthError {
    failed(format!(
        "at most {MAX_ACCOUNTS} Google accounts can be connected; disconnect one first"
    ))
}

impl Index {
    fn find(&self, id: &str) -> Result<&Account> {
        self.accounts
            .iter()
            .find(|account| account.id == id)
            .ok_or_else(|| failed("that Google account is not connected anymore"))
    }

    fn find_mut(&mut self, id: &str) -> Result<&mut Account> {
        self.accounts
            .iter_mut()
            .find(|account| account.id == id)
            .ok_or_else(|| failed("that Google account is not connected anymore"))
    }

    fn view(&self, account: &Account) -> AccountView {
        let granted = |scope: &str| account.scopes.iter().any(|item| item == scope);
        AccountView {
            id: account.id.clone(),
            email: account.email.clone(),
            alias: account.alias.clone(),
            // A lone account is the default without being chosen.
            is_default: self.accounts.len() == 1
                || self.default_id.as_deref() == Some(account.id.as_str()),
            mail_read: granted(MAIL_READ),
            mail_send: granted(MAIL_SEND),
            calendar: granted(CALENDAR),
        }
    }

    fn views(&self) -> Vec<AccountView> {
        self.accounts.iter().map(|a| self.view(a)).collect()
    }

    /// Adds an account, or updates the one with the same email, which keeps
    /// its id, alias and default. Returns the id and whether it is new.
    fn add_or_replace(
        &mut self,
        email: &str,
        scopes: Vec<String>,
        new_id: String,
    ) -> Result<(String, bool)> {
        if let Some(existing) = self
            .accounts
            .iter_mut()
            .find(|account| account.email.eq_ignore_ascii_case(email))
        {
            existing.scopes = scopes;
            return Ok((existing.id.clone(), false));
        }
        if self.accounts.len() >= MAX_ACCOUNTS {
            return Err(too_many());
        }
        // With a second account there is no obvious default: the first one
        // was only implied, so the user has to choose.
        self.accounts.push(Account {
            id: new_id.clone(),
            email: email.to_owned(),
            alias: None,
            scopes,
        });
        Ok((new_id, true))
    }

    fn remove(&mut self, id: &str) {
        self.accounts.retain(|account| account.id != id);
        if self.default_id.as_deref() == Some(id) {
            self.default_id = None;
        }
    }

    /// Sets or clears (empty text) the alias, and optionally makes the
    /// account the default.
    fn update(&mut self, id: &str, alias: Option<&str>, make_default: bool) -> Result<()> {
        let alias = alias.map(str::trim).filter(|alias| !alias.is_empty());
        if let Some(alias) = alias {
            if alias.chars().count() > MAX_ALIAS_CHARS
                || alias.contains('@')
                || alias.chars().any(char::is_control)
            {
                return Err(failed(format!(
                    "an alias is at most {MAX_ALIAS_CHARS} characters, without \"@\""
                )));
            }
            let taken = self.accounts.iter().any(|account| {
                account.id != id
                    && account
                        .alias
                        .as_ref()
                        .is_some_and(|other| other.to_lowercase() == alias.to_lowercase())
            });
            if taken {
                return Err(failed("another account already uses that alias"));
            }
        }
        self.find_mut(id)?.alias = alias.map(str::to_owned);
        if make_default {
            self.default_id = Some(id.to_owned());
        }
        Ok(())
    }
}

fn new_account_id() -> Result<String> {
    let mut bytes = [0; secrets::ACCOUNT_ID_LENGTH / 2];
    getrandom::fill(&mut bytes).map_err(|error| failed(format!("no random data: {error}")))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// The address of the account that just signed in.
async fn email_address(access_token: &str) -> Result<String> {
    let transport =
        |error: reqwest::Error| failed(format!("Gmail is not reachable: {}", error.without_url()));
    let response = super::http_client()
        .map_err(failed)?
        .get(PROFILE_URL)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(transport)?;
    let status = response.status();
    let body: Value = response.json().await.map_err(transport)?;
    match body["emailAddress"].as_str() {
        Some(email) if status.is_success() => Ok(email.to_owned()),
        _ => Err(failed(format!(
            "Gmail did not say which account this is: {}",
            body["error"]["message"].as_str().unwrap_or("unknown error")
        ))),
    }
}

/// Managed as Tauri state. The lock covers each read-modify-write of the
/// list and the credential entries that go with it; it is never held while
/// waiting for the network.
pub struct GoogleAccounts {
    dir: PathBuf,
    lock: Mutex<()>,
}

impl GoogleAccounts {
    pub fn new(dir: DataDir) -> Self {
        Self {
            dir: dir.0,
            lock: Mutex::new(()),
        }
    }

    fn guard(&self) -> Result<MutexGuard<'_, ()>> {
        self.lock
            .lock()
            .map_err(|_| failed("the account list is unavailable"))
    }

    /// A damaged file is an error, so it is never replaced by an empty list.
    fn load(&self) -> Result<Index> {
        let unreadable = |error: String| {
            failed(format!(
                "the Google account list could not be read: {error}"
            ))
        };
        match data::read_any(&self.dir, DOCUMENT).map_err(|e| unreadable(e.to_string()))? {
            Some(value) => serde_json::from_value(value).map_err(|e| unreadable(e.to_string())),
            None => Ok(Index::default()),
        }
    }

    fn save(&self, index: &Index) -> Result<()> {
        let unsaved =
            |error: String| failed(format!("the Google account list was not saved: {error}"));
        let value = serde_json::to_value(index).map_err(|e| unsaved(e.to_string()))?;
        data::write_any(&self.dir, DOCUMENT, &value).map_err(|e| unsaved(e.to_string()))
    }

    pub fn list(&self) -> Result<Vec<AccountView>> {
        let _guard = self.guard()?;
        Ok(self.load()?.views())
    }

    /// Signs in and stores the account. `login_hint` is the email of an
    /// account being reconnected.
    pub async fn connect(
        &self,
        cache: &TokenCache,
        login_hint: Option<&str>,
        open_browser: impl FnOnce(&str) -> std::result::Result<(), String>,
    ) -> Result<Connected> {
        {
            let _guard = self.guard()?;
            // Refused before the browser opens, unless it is a reconnection.
            if login_hint.is_none() && self.load()?.accounts.len() >= MAX_ACCOUNTS {
                return Err(too_many());
            }
        }
        let signed_in = oauth::authorize(Provider::Google, login_hint, open_browser).await?;
        if !signed_in.scopes.iter().any(|scope| scope == MAIL_READ) {
            return Err(failed(
                "permission to read Gmail was not granted, so the account was not added. \
                 Connect again and tick every permission",
            ));
        }
        let email = email_address(&signed_in.access_token).await?;

        let _guard = self.guard()?;
        let mut index = self.load()?;
        let (id, is_new) = index.add_or_replace(&email, signed_in.scopes, new_account_id()?)?;
        let token_name = secrets::google_token_name(&id)?;
        secrets::set(&token_name, &signed_in.refresh_token)?;
        if let Err(error) = self.save(&index) {
            if is_new {
                let _ = secrets::delete(&token_name);
            }
            return Err(error);
        }
        cache.put(&token_name, &signed_in.access_token, signed_in.lifetime);
        Ok(Connected {
            account: index.view(index.find(&id)?),
            is_new,
        })
    }

    /// A valid access token for one account, renewed when needed.
    pub async fn access_token(&self, cache: &TokenCache, id: &str) -> Result<String> {
        let token_name = secrets::google_token_name(id)?;
        let (email, stored) = {
            let _guard = self.guard()?;
            let email = self.load()?.find(id)?.email.clone();
            if let Some(token) = cache.get(&token_name) {
                return Ok(token);
            }
            let stored = secrets::get(&token_name)?
                .ok_or_else(|| OAuthError::AccountNotConnected(email.clone()))?;
            (email, stored)
        };
        let renewed =
            oauth::refresh(Provider::Google, &stored)
                .await
                .map_err(|error| match error {
                    OAuthError::NotConnected(_) => OAuthError::AccountNotConnected(email),
                    other => other,
                })?;

        let _guard = self.guard()?;
        let mut index = self.load()?;
        // Fails if the account was disconnected in the meantime, so nothing
        // is stored for it again.
        let account = index.find_mut(id)?;
        if let Some(rotated) = &renewed.refresh_token {
            secrets::set(&token_name, rotated)?;
        }
        if let Some(scopes) = renewed.scopes
            && scopes != account.scopes
        {
            account.scopes = scopes;
            self.save(&index)?;
        }
        cache.put(&token_name, &renewed.access_token, renewed.lifetime);
        Ok(renewed.access_token)
    }

    /// Forgets the account and its token on this computer. It does not revoke
    /// the permission at Google.
    pub fn disconnect(&self, cache: &TokenCache, id: &str) -> Result<()> {
        let token_name = secrets::google_token_name(id)?;
        let _guard = self.guard()?;
        let mut index = self.load()?;
        secrets::delete(&token_name)?;
        cache.forget(&token_name);
        index.remove(id);
        self.save(&index)
    }

    pub fn update(&self, id: &str, alias: Option<&str>, make_default: bool) -> Result<()> {
        let _guard = self.guard()?;
        let mut index = self.load()?;
        index.update(id, alias, make_default)?;
        self.save(&index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(emails: &[&str]) -> Index {
        let mut index = Index::default();
        for (number, email) in emails.iter().enumerate() {
            index
                .add_or_replace(email, vec![MAIL_READ.into()], format!("id{number}"))
                .expect("add");
        }
        index
    }

    #[test]
    fn a_lone_account_is_the_default_but_two_need_a_choice() {
        assert!(index(&["a@x.test"]).views()[0].is_default);
        let mut two = index(&["a@x.test", "b@x.test"]);
        assert!(two.views().iter().all(|a| !a.is_default));
        two.update("id1", None, true).expect("default");
        let defaults: Vec<_> = two.views().into_iter().map(|a| a.is_default).collect();
        assert_eq!(defaults, [false, true]);
    }

    #[test]
    fn signing_in_again_keeps_the_account() {
        let mut index = index(&["a@x.test", "b@x.test"]);
        index.update("id0", Some("work"), true).expect("update");
        let (id, is_new) = index
            .add_or_replace("A@X.test", vec![CALENDAR.into()], "other".into())
            .expect("replace");
        assert_eq!((id.as_str(), is_new), ("id0", false));
        let view = &index.views()[0];
        assert_eq!(view.alias.as_deref(), Some("work"));
        assert!(view.is_default && view.calendar && !view.mail_read);
    }

    #[test]
    fn limits_the_number_of_accounts() {
        let emails: Vec<_> = (0..MAX_ACCOUNTS).map(|n| format!("{n}@x.test")).collect();
        let mut full = index(&emails.iter().map(String::as_str).collect::<Vec<_>>());
        assert!(
            full.add_or_replace("new@x.test", vec![], "n".into())
                .is_err()
        );
        assert!(full.add_or_replace("0@x.test", vec![], "n".into()).is_ok());
    }

    #[test]
    fn removing_the_default_leaves_none() {
        let mut index = index(&["a@x.test", "b@x.test", "c@x.test"]);
        index.update("id0", None, true).expect("default");
        index.remove("id0");
        assert_eq!(index.default_id, None);
        assert!(index.views().iter().all(|a| !a.is_default));
    }

    #[test]
    fn checks_aliases() {
        let mut index = index(&["a@x.test", "b@x.test"]);
        index
            .update("id0", Some(" Trabajo "), false)
            .expect("alias");
        assert_eq!(index.accounts[0].alias.as_deref(), Some("Trabajo"));
        for bad in ["trabajo", "b@x.test", &"x".repeat(31), "a\nb"] {
            assert!(index.update("id1", Some(bad), false).is_err(), "{bad:?}");
        }
        index.update("id0", Some(""), false).expect("clear");
        assert_eq!(index.accounts[0].alias, None);
        assert!(index.update("missing", None, true).is_err());
    }

    #[test]
    fn stores_the_list_and_never_replaces_a_damaged_file() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!("jarvis-accounts-{nanos}"));
        let accounts = GoogleAccounts::new(DataDir(dir.clone()));
        assert!(accounts.list().expect("empty").is_empty());
        accounts.save(&index(&["a@x.test"])).expect("save");
        assert_eq!(accounts.list().expect("list")[0].email, "a@x.test");

        let path = dir.join(format!("{DOCUMENT}.json"));
        std::fs::write(&path, "{ not json").expect("damage");
        assert!(accounts.list().is_err());
        assert!(accounts.update("id0", None, true).is_err());
        assert_eq!(std::fs::read_to_string(&path).expect("read"), "{ not json");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_webview_cannot_write_the_list() {
        assert!(!data::ALLOWED.contains(&DOCUMENT));
    }

    #[test]
    fn new_ids_are_valid_token_names() {
        let id = new_account_id().expect("id");
        assert!(secrets::is_account_id(&id), "{id}");
    }
}
