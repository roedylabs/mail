//! Server texts in the recipient's language: notifications, audit log, mail
//! subjects and details. The texts live in `locales/<lang>.json` as flat maps
//! from key to text, embedded in the binary and parsed once. Placeholders
//! are written `{name}`; plurals use the keys `<key>.one` and `<key>.other`.
//! The mail bodies are Askama templates under `templates/<lang>/`.
//!
//! A key missing in a language falls back to English, a key missing in
//! English to the key itself; tests keep both files in step.

use std::{
    collections::HashMap,
    fmt::Display,
    sync::{LazyLock, Mutex, PoisonError},
};

use crate::settings::Language;

type Texts = HashMap<String, String>;

fn parse(lang: &str, json: &str) -> Texts {
    serde_json::from_str(json).unwrap_or_else(|err| panic!("locales/{lang}.json: {err}"))
}

static ENGLISH: LazyLock<Texts> = LazyLock::new(|| parse("en", include_str!("../locales/en.json")));
static GERMAN: LazyLock<Texts> = LazyLock::new(|| parse("de", include_str!("../locales/de.json")));

fn texts(lang: Language) -> &'static Texts {
    match lang {
        Language::English => &ENGLISH,
        Language::German => &GERMAN,
    }
}

/// The text of `key` in `lang`.
pub fn t(lang: Language, key: &str) -> &'static str {
    if let Some(text) = lookup(texts(lang), &ENGLISH, key) {
        return text;
    }
    // Unknown keys only reach release builds through a programming error;
    // showing the key beats panicking in a request.
    debug_assert!(false, "unknown text key {key}");
    unknown(key)
}

/// `key` in `texts`, otherwise in `fallback`.
fn lookup<'a>(texts: &'a Texts, fallback: &'a Texts, key: &str) -> Option<&'a str> {
    texts
        .get(key)
        .or_else(|| fallback.get(key))
        .map(String::as_str)
}

/// `key` itself as a text, kept once per key.
fn unknown(key: &str) -> &'static str {
    static KEYS: LazyLock<Mutex<HashMap<String, &'static str>>> = LazyLock::new(Mutex::default);
    let mut keys = KEYS.lock().unwrap_or_else(PoisonError::into_inner);
    keys.entry(key.to_owned())
        .or_insert_with(|| Box::leak(key.to_owned().into_boxed_str()))
}

/// The text of `key` in `lang` with its `{name}` placeholders replaced.
pub fn tf(lang: Language, key: &str, args: &[(&str, &dyn Display)]) -> String {
    fill(t(lang, key), args)
}

/// `<key>.one` for 1, otherwise `<key>.other`, with `{count}` set to `n`
/// besides `args`.
pub fn plural(lang: Language, key: &str, n: u64, args: &[(&str, &dyn Display)]) -> String {
    let form = if n == 1 { "one" } else { "other" };
    let text = t(lang, &format!("{key}.{form}"));
    let mut all: Vec<(&str, &dyn Display)> = vec![("count", &n)];
    all.extend_from_slice(args);
    fill(text, &all)
}

fn fill(text: &str, args: &[(&str, &dyn Display)]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let value = after.find('}').and_then(|close| {
            let name = &after[..close];
            let (_, value) = args.iter().find(|(key, _)| *key == name)?;
            Some((value, close))
        });
        match value {
            Some((value, close)) => {
                out.push_str(&value.to_string());
                rest = &after[close + 1..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Placeholders of a text, sorted.
#[cfg(test)]
fn placeholders(text: &str) -> Vec<&str> {
    let mut names: Vec<&str> = text
        .split('{')
        .skip(1)
        .filter_map(|part| part.split_once('}').map(|(name, _)| name))
        .collect();
    names.sort_unstable();
    names.dedup();
    names
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeSet, fs, path::Path};

    use super::*;

    #[test]
    fn both_languages_have_the_same_keys_and_placeholders() {
        let english: BTreeSet<_> = ENGLISH.keys().collect();
        let german: BTreeSet<_> = GERMAN.keys().collect();
        assert_eq!(
            english.difference(&german).collect::<Vec<_>>(),
            Vec::<&&String>::new(),
            "missing in de.json"
        );
        assert_eq!(
            german.difference(&english).collect::<Vec<_>>(),
            Vec::<&&String>::new(),
            "missing in en.json"
        );
        for key in english {
            assert_eq!(
                placeholders(&ENGLISH[key]),
                placeholders(&GERMAN[key]),
                "placeholders of {key}"
            );
            assert!(!ENGLISH[key].is_empty() && !GERMAN[key].is_empty(), "{key}");
        }
    }

    #[test]
    fn every_template_exists_in_both_languages() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("templates");
        let names = |lang: &str| -> BTreeSet<String> {
            fs::read_dir(root.join(lang))
                .unwrap()
                .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                .collect()
        };
        let english = names("en");
        assert!(english.contains("layout.html"), "{english:?}");
        assert_eq!(english, names("de"));
        let top: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap())
            .filter(|entry| entry.file_type().unwrap().is_file())
            .map(|entry| entry.file_name())
            .collect();
        assert!(top.is_empty(), "templates outside a language: {top:?}");
    }

    #[test]
    fn fills_placeholders_and_plurals() {
        assert_eq!(fill("{a} and {b}", &[("a", &1), ("b", &"x")]), "1 and x");
        assert_eq!(fill("{unknown} {", &[]), "{unknown} {");
        assert_eq!(plural(Language::English, "duration.days", 1, &[]), "1 day");
        assert_eq!(plural(Language::English, "duration.days", 3, &[]), "3 days");
    }

    #[test]
    fn texts_come_from_the_language_and_fall_back_to_english() {
        assert_eq!(placeholders("{b} {a} {b}"), ["a", "b"]);
        assert_eq!(
            t(Language::English, "topic.security"),
            ENGLISH["topic.security"]
        );
        assert_eq!(
            t(Language::German, "topic.security"),
            GERMAN["topic.security"]
        );
        let texts = |pairs: &[(&str, &str)]| -> Texts {
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect()
        };
        let english = texts(&[("a", "en a"), ("b", "en b")]);
        let other = texts(&[("a", "other a")]);
        assert_eq!(lookup(&other, &english, "a"), Some("other a"));
        assert_eq!(lookup(&other, &english, "b"), Some("en b"));
        assert_eq!(lookup(&other, &english, "c"), None);
    }
}
