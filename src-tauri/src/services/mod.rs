//! Backend services behind the platform-independent tools. Anything that
//! needs a credential the webview must not read, or a request the browser's
//! CORS rules block, lives here.

pub mod browser;
pub mod google_accounts;
pub mod oauth;
pub mod system_stats;
pub mod telegram;
pub mod youtube;

use std::time::Duration;

const HTTP_TIMEOUT: Duration = Duration::from_secs(20);

/// An HTTP client with a timeout.
pub(crate) fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|error| error.without_url().to_string())
}
