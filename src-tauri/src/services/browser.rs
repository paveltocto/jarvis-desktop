//! A browser window JARVIS controls over the Chrome DevTools Protocol
//! (legacy `browser_control`, which typed into whatever window was active).
//! It has its own profile, so it does not share the user's logins.

use chromiumoxide::{Browser, BrowserConfig, Page};
use futures_util::StreamExt;
use serde::Deserialize;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::Mutex;
use url::Url;

const STEP_TIMEOUT: Duration = Duration::from_secs(25);
const MAX_PAGE_CHARS: usize = 4_000;
const SEARCH: &str = "https://www.google.com/search";

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Up,
    Down,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Request {
    GoTo { url: String },
    Search { query: String },
    NewTab { url: Option<String> },
    CloseTab,
    Scroll { direction: Direction },
    Read,
}

/// Only web pages: no `file:`, `javascript:` or `chrome:` URLs. A bare host
/// such as `example.com` gets `https://`.
pub fn web_url(input: &str) -> Result<String, String> {
    let input = input.trim();
    let candidate = if input.contains("://") {
        input.to_owned()
    } else {
        format!("https://{input}")
    };
    match Url::parse(&candidate) {
        Ok(url) if matches!(url.scheme(), "http" | "https") && url.host().is_some() => {
            Ok(url.into())
        }
        _ => Err(format!("\"{input}\" is not a web address")),
    }
}

fn search_url(query: &str) -> Result<String, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("the search is empty".to_owned());
    }
    Url::parse_with_params(SEARCH, [("q", query)])
        .map(Into::into)
        .map_err(|error| error.to_string())
}

struct Session {
    browser: Browser,
    page: Page,
    alive: Arc<AtomicBool>,
}

/// The controlled browser, started on first use.
pub struct BrowserService {
    profile: PathBuf,
    headless: bool,
    session: Mutex<Option<Session>>,
}

async fn within<T, E: std::fmt::Display>(
    step: impl Future<Output = Result<T, E>>,
) -> Result<T, String> {
    match tokio::time::timeout(STEP_TIMEOUT, step).await {
        Ok(result) => result.map_err(|error| format!("browser error: {error}")),
        Err(_) => Err("the browser did not answer in time".to_owned()),
    }
}

async fn launch(profile: &Path, headless: bool) -> Result<Session, String> {
    let mut config = BrowserConfig::builder()
        .user_data_dir(profile)
        .viewport(None);
    if !headless {
        config = config.with_head();
    }
    let config = config
        .build()
        .map_err(|error| format!("Google Chrome or Chromium is needed: {error}"))?;
    let (browser, mut handler) = within(Browser::launch(config)).await?;
    let alive = Arc::new(AtomicBool::new(true));
    let flag = Arc::clone(&alive);
    tokio::spawn(async move {
        while let Some(event) = handler.next().await {
            // Unknown protocol messages are errors here but harmless.
            if let Err(chromiumoxide::error::CdpError::Ws(_)) = event {
                break;
            }
        }
        flag.store(false, Ordering::SeqCst);
    });
    let page = within(browser.new_page("about:blank")).await?;
    Ok(Session {
        browser,
        page,
        alive,
    })
}

async fn describe(page: &Page) -> Result<String, String> {
    let title = within(page.get_title()).await?.unwrap_or_default();
    let url = within(page.url()).await?.unwrap_or_default();
    Ok(format!("\"{title}\" ({url})"))
}

async fn navigate(page: &Page, url: &str) -> Result<String, String> {
    within(page.goto(url)).await?;
    let _ = within(page.bring_to_front()).await;
    describe(page).await
}

impl Session {
    /// Whether the window and the current tab are still there (the user may
    /// have closed them by hand).
    async fn usable(&self) -> bool {
        self.alive.load(Ordering::SeqCst) && within(self.page.url()).await.is_ok()
    }

    async fn run(&mut self, request: &Request) -> Result<String, String> {
        match request {
            Request::GoTo { url } => {
                let shown = navigate(&self.page, &web_url(url)?).await?;
                Ok(format!("Opened {shown}."))
            }
            Request::Search { query } => {
                let shown = navigate(&self.page, &search_url(query)?).await?;
                Ok(format!("Searched in the browser: {shown}."))
            }
            Request::NewTab { url } => {
                let url = url.as_deref().map(web_url).transpose()?;
                self.page = within(self.browser.new_page("about:blank")).await?;
                match url {
                    Some(url) => Ok(format!(
                        "Opened a new tab with {}.",
                        navigate(&self.page, &url).await?
                    )),
                    None => Ok("Opened a new tab.".to_owned()),
                }
            }
            Request::CloseTab => {
                let closing = self.page.target_id().clone();
                let remaining = within(self.browser.pages())
                    .await?
                    .into_iter()
                    .rfind(|page| *page.target_id() != closing);
                // Chrome quits when its last tab closes, so keep a blank one.
                let next = match remaining {
                    Some(page) => page,
                    None => within(self.browser.new_page("about:blank")).await?,
                };
                let old = std::mem::replace(&mut self.page, next);
                within(old.close()).await?;
                let _ = within(self.page.bring_to_front()).await;
                Ok("Closed the tab.".to_owned())
            }
            Request::Scroll { direction } => {
                let sign = match direction {
                    Direction::Up => -1,
                    Direction::Down => 1,
                };
                within(self.page.evaluate(format!(
                    "window.scrollBy(0, {sign} * window.innerHeight * 0.8)"
                )))
                .await?;
                Ok("Scrolled.".to_owned())
            }
            Request::Read => {
                let result = within(
                    self.page
                        .evaluate("document.body ? document.body.innerText : ''"),
                )
                .await?;
                let text: String = result
                    .into_value()
                    .map_err(|error| format!("browser error: {error}"))?;
                let text: String = text.trim().chars().take(MAX_PAGE_CHARS).collect();
                Ok(format!(
                    "Page {}:\n{}",
                    describe(&self.page).await?,
                    if text.is_empty() { "(no text)" } else { &text }
                ))
            }
        }
    }
}

impl BrowserService {
    pub fn new(profile: PathBuf) -> Self {
        Self {
            profile,
            headless: false,
            session: Mutex::new(None),
        }
    }

    pub async fn run(&self, request: Request) -> Result<String, String> {
        let mut slot = self.session.lock().await;
        let usable = match slot.as_ref() {
            Some(session) => session.usable().await,
            None => false,
        };
        if !usable {
            if let Some(mut stale) = slot.take() {
                let _ = within(stale.browser.close()).await;
                let _ = within(stale.browser.wait()).await;
            }
            // Reading, scrolling or closing needs a page JARVIS already opened.
            if matches!(
                request,
                Request::Read | Request::Scroll { .. } | Request::CloseTab
            ) {
                return Err("the JARVIS browser window is not open".to_owned());
            }
            *slot = Some(launch(&self.profile, self.headless).await?);
        }
        let Some(session) = slot.as_mut() else {
            return Err("the browser could not be started".to_owned());
        };
        session.run(&request).await
    }

    /// Closes the browser if it is running.
    pub async fn close(&self) {
        if let Some(mut session) = self.session.lock().await.take() {
            let _ = within(session.browser.close()).await;
            let _ = within(session.browser.wait()).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_web_addresses_only() {
        assert_eq!(web_url("example.com").expect("url"), "https://example.com/");
        assert_eq!(web_url("http://a.test/x").expect("url"), "http://a.test/x");
        for bad in [
            "file:///etc/passwd",
            "chrome://settings",
            "javascript://%0Aalert(1)",
            "javascript:alert(1)",
            "",
        ] {
            assert!(web_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn encodes_searches() {
        let url = search_url("a&b c").expect("url");
        assert!(url.ends_with("q=a%26b+c"), "{url}");
        assert!(search_url("  ").is_err());
    }

    #[test]
    fn deserializes_the_webview_shape() {
        let request: Request =
            serde_json::from_value(serde_json::json!({ "action": "scroll", "direction": "up" }))
                .expect("deserialize");
        assert!(matches!(request, Request::Scroll { .. }));
    }

    /// Needs Chrome and the network: `cargo test live_browser -- --ignored`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "starts Chrome and uses the network"]
    async fn live_browser_opens_reads_and_closes_pages() {
        let profile =
            std::env::temp_dir().join(format!("jarvis-browser-test-{}", std::process::id()));
        let service = BrowserService {
            headless: true,
            ..BrowserService::new(profile.clone())
        };
        assert!(service.run(Request::Read).await.is_err());
        let steps = [
            Request::GoTo {
                url: "example.com".into(),
            },
            Request::Read,
            Request::Scroll {
                direction: Direction::Down,
            },
            Request::NewTab {
                url: Some("example.org".into()),
            },
            Request::CloseTab,
            Request::Read,
            Request::CloseTab,
            Request::GoTo {
                url: "example.com".into(),
            },
        ];
        for step in steps {
            let outcome = service.run(step.clone()).await;
            println!("{step:?} -> {outcome:?}");
            assert!(outcome.is_ok());
        }
        service.close().await;
        let _ = std::fs::remove_dir_all(profile);
    }
}
