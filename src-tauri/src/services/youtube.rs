//! Finds the first video for a search (legacy `youtube_video`). The request
//! is made here because YouTube does not allow it from a web page.

use super::http_client;

const SEARCH: &str = "https://www.youtube.com/results";
const ID_LENGTH: usize = 11;

/// The first video id in a YouTube results page.
pub fn first_video_id(html: &str) -> Option<&str> {
    let marker = "\"videoId\":\"";
    html.match_indices(marker).find_map(|(start, _)| {
        let rest = &html[start + marker.len()..];
        let id = &rest[..rest.find('"')?];
        let valid = id.len() == ID_LENGTH
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
        valid.then_some(id)
    })
}

/// URL of the first result, or `None` when the page lists no video (YouTube
/// may change its page or answer with a consent screen).
pub async fn first_video_url(query: &str) -> Result<Option<String>, String> {
    let response = http_client()?
        .get(SEARCH)
        .query(&[("search_query", query)])
        .header("Accept-Language", "en")
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| format!("YouTube is not reachable: {}", error.without_url()))?;
    let html = response
        .text()
        .await
        .map_err(|error| format!("YouTube is not reachable: {}", error.without_url()))?;
    Ok(first_video_id(&html).map(|id| format!("https://www.youtube.com/watch?v={id}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_first_well_formed_id() {
        let html = r#"{"videoId":"short"},{"videoId":"dQw4w9WgXcQ"},{"videoId":"aaaaaaaaaaa"}"#;
        assert_eq!(first_video_id(html), Some("dQw4w9WgXcQ"));
    }

    #[test]
    fn ignores_pages_without_videos() {
        assert_eq!(first_video_id("<html>consent</html>"), None);
        assert_eq!(first_video_id(r#""videoId":"<script>xx""#), None);
    }

    /// Needs the network: `cargo test live_youtube -- --ignored`.
    #[tokio::test]
    #[ignore = "uses the network"]
    async fn live_youtube_search_returns_a_video() {
        let url = first_video_url("never gonna give you up")
            .await
            .expect("request");
        println!("{url:?}");
        assert!(url.is_some());
    }
}
