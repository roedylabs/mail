//! GitHub Releases API: the newest version of the public repository. A token
//! is optional and only raises GitHub's rate limit for unauthenticated
//! requests. The list of releases tells "no release yet" apart from "no
//! access" and allows comparing by semver instead of by date.

use reqwest::{
    Client, StatusCode,
    header::{ACCEPT, HeaderMap},
};
use semver::Version;
use serde::Deserialize;
use url::Url;

/// Address of the API, replaceable for tests in `AppState::github_api`.
pub const API: &str = "https://api.github.com/";
/// Repository of the releases.
const REPOSITORY: &str = "roedylabs/mail";
/// One page is enough: the newest version is among the latest releases.
const PER_PAGE: u8 = 30;
/// Length of the summary in characters; the notification shortens further.
const MAX_SUMMARY: usize = 200;

/// Newest version with the first item of its release notes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    pub version: String,
    pub summary: Option<String>,
}

/// Why a check failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// Token invalid or expired (401).
    Token,
    /// No access to the repository (403, 404).
    NoAccess,
    /// GitHub rate limit.
    RateLimited,
    /// GitHub unreachable or response unusable.
    Unreachable,
}

impl Failure {
    /// Reason in `update_state.reason` and `GET admin/updates`.
    pub fn code(self) -> &'static str {
        match self {
            Self::Token => "token",
            Self::NoAccess => "no_access",
            Self::RateLimited => "rate_limited",
            Self::Unreachable => "unreachable",
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

/// Queries the newest version, with `token` if one is stored; `None` if there
/// is no release yet.
pub async fn newest(
    http: &Client,
    api: &Url,
    token: Option<&str>,
) -> Result<Option<Release>, Failure> {
    let url = api
        .join(&format!("repos/{REPOSITORY}/releases?per_page={PER_PAGE}"))
        .map_err(|_| Failure::Unreachable)?;
    let mut request = http
        .get(url)
        .header(ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.map_err(|error| {
        tracing::debug!("GitHub not reachable: {error:#}");
        Failure::Unreachable
    })?;
    match response.status() {
        StatusCode::OK => {}
        StatusCode::UNAUTHORIZED => return Err(Failure::Token),
        StatusCode::NOT_FOUND => return Err(Failure::NoAccess),
        StatusCode::TOO_MANY_REQUESTS => return Err(Failure::RateLimited),
        StatusCode::FORBIDDEN if limited(response.headers()) => return Err(Failure::RateLimited),
        StatusCode::FORBIDDEN => return Err(Failure::NoAccess),
        status => {
            tracing::debug!(%status, "unexpected response from GitHub");
            return Err(Failure::Unreachable);
        }
    }
    let releases = response.json::<Vec<RawRelease>>().await.map_err(|error| {
        tracing::debug!("response from GitHub not readable: {error:#}");
        Failure::Unreachable
    })?;
    Ok(newest_of(releases))
}

/// GitHub also reports the rate limit as 403.
fn limited(headers: &HeaderMap) -> bool {
    headers.contains_key("retry-after")
        || headers
            .get("x-ratelimit-remaining")
            .is_some_and(|remaining| remaining == "0")
}

/// Highest version, without drafts and pre-releases.
fn newest_of(releases: Vec<RawRelease>) -> Option<Release> {
    releases
        .into_iter()
        .filter(|release| !release.draft && !release.prerelease)
        .filter_map(|release| {
            let tag = release.tag_name.strip_prefix('v')?;
            let version = Version::parse(tag).ok().filter(|v| v.pre.is_empty())?;
            Some((version, release.body))
        })
        .max_by(|(left, _), (right, _)| left.cmp(right))
        .map(|(version, body)| Release {
            version: version.to_string(),
            summary: body.as_deref().and_then(summary_of),
        })
}

/// First item of the release notes without the markup from `cliff.toml`:
/// "- **server:** Log with filters ([#12](…))" becomes "Log with filters".
fn summary_of(notes: &str) -> Option<String> {
    let mut text = notes
        .lines()
        .find_map(|line| line.trim().strip_prefix("- "))?
        .trim();
    while let Some((_, rest)) = text
        .strip_prefix("**")
        .and_then(|rest| rest.split_once("** "))
    {
        text = rest;
    }
    if let Some((head, _)) = text.rsplit_once(" ([#") {
        text = head;
    }
    let text: String = text.chars().take(MAX_SUMMARY).collect();
    let text = text.trim_end();
    (!text.is_empty()).then(|| text.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str) -> RawRelease {
        RawRelease {
            tag_name: tag.to_owned(),
            body: None,
            draft: false,
            prerelease: false,
        }
    }

    #[test]
    fn picks_the_highest_version_not_the_first() {
        let newest = newest_of(vec![
            release("v0.9.0"),
            release("v0.10.0"),
            release("v0.2.1"),
        ]);
        assert_eq!(newest.unwrap().version, "0.10.0");
    }

    #[test]
    fn skips_drafts_prereleases_and_other_tags() {
        let mut draft = release("v9.0.0");
        draft.draft = true;
        let mut pre = release("v8.0.0");
        pre.prerelease = true;
        let newest = newest_of(vec![
            draft,
            pre,
            release("v7.0.0-rc.1"),
            release("nightly"),
            release("6.0.0"),
            release("v1.2.3"),
        ]);
        assert_eq!(newest.unwrap().version, "1.2.3");
        assert_eq!(newest_of(vec![release("nightly")]), None);
        assert_eq!(newest_of(Vec::new()), None);
    }

    #[test]
    fn summary_is_the_first_point_of_the_notes() {
        let notes = "## [0.7.0] – 2026-11-05\n\n### Features\n\n\
                     - **server:** Log with filters ([#12](https://github.com/x/y/pull/12))\n\
                     - **web:** Banner\n\n## Image\n\n```sh\ndocker pull …\n```\n";
        assert_eq!(summary_of(notes).as_deref(), Some("Log with filters"));
        assert_eq!(
            summary_of("- **web:** **[breaking]** New addresses").as_deref(),
            Some("New addresses")
        );
        assert_eq!(summary_of("- Plain").as_deref(), Some("Plain"));
        assert_eq!(summary_of("## Only a heading\n\nText"), None);
        assert_eq!(summary_of("- "), None);
        assert_eq!(
            summary_of(&format!("- {}", "é".repeat(500)))
                .unwrap()
                .chars()
                .count(),
            MAX_SUMMARY
        );
    }

    #[test]
    fn rate_limit_shows_in_the_headers() {
        let mut headers = HeaderMap::new();
        assert!(!limited(&headers));
        headers.insert("x-ratelimit-remaining", "12".parse().unwrap());
        assert!(!limited(&headers));
        headers.insert("x-ratelimit-remaining", "0".parse().unwrap());
        assert!(limited(&headers));
        let mut headers = HeaderMap::new();
        headers.insert("retry-after", "60".parse().unwrap());
        assert!(limited(&headers));
    }
}
