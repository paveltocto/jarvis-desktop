//! Schedule part of the rules engine.
//!
//! The webview owns the `rules` document and computes each rule's
//! `nextRunAtMs`. This module only reads it, and emits `rule:due` when a
//! scheduled time has passed. The webview runs the action and moves
//! `nextRunAtMs` forward. This keeps a single writer for the document.

use crate::data::{self, DataDir};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// Frontend event. Payload: [`RuleDue`].
pub const EVENT_DUE: &str = "rule:due";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleDue {
    pub id: String,
    pub next_run_at_ms: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRule {
    id: String,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    next_run_at_ms: Option<i64>,
}

/// Reads the rules document. A missing document means no rules.
pub fn load(dir: &DataDir) -> Result<Value, data::DataError> {
    Ok(data::read_any(&dir.0, "rules")?.unwrap_or_else(|| Value::Array(Vec::new())))
}

/// Rules whose scheduled time has passed and that have not fired for that
/// exact time yet. `fired` remembers the last scheduled time fired per rule,
/// so a rule is not fired twice while the webview has not updated it yet.
pub fn due(rules: &Value, now_ms: i64, fired: &mut HashMap<String, i64>) -> Vec<RuleDue> {
    let Some(items) = rules.as_array() else {
        fired.clear();
        return Vec::new();
    };
    let mut present = HashSet::new();
    let mut out = Vec::new();
    for item in items {
        let Ok(rule) = serde_json::from_value::<StoredRule>(item.clone()) else {
            continue;
        };
        present.insert(rule.id.clone());
        let Some(next) = rule.next_run_at_ms else {
            continue;
        };
        if !rule.enabled || next > now_ms || fired.get(&rule.id) == Some(&next) {
            continue;
        }
        fired.insert(rule.id.clone(), next);
        out.push(RuleDue {
            id: rule.id,
            next_run_at_ms: next,
        });
    }
    fired.retain(|id, _| present.contains(id));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rules(next: i64, enabled: bool) -> Value {
        json!([{ "id": "r1", "enabled": enabled, "nextRunAtMs": next }])
    }

    #[test]
    fn fires_once_when_the_time_has_passed() {
        let mut fired = HashMap::new();
        let doc = rules(1_000, true);
        assert_eq!(due(&doc, 1_500, &mut fired).len(), 1);
        assert!(due(&doc, 2_000, &mut fired).is_empty());
    }

    #[test]
    fn waits_until_the_time_arrives() {
        let mut fired = HashMap::new();
        assert!(due(&rules(1_000, true), 999, &mut fired).is_empty());
    }

    #[test]
    fn fires_again_after_the_webview_moves_the_time() {
        let mut fired = HashMap::new();
        assert_eq!(due(&rules(1_000, true), 1_500, &mut fired).len(), 1);
        assert_eq!(due(&rules(5_000, true), 5_100, &mut fired).len(), 1);
    }

    #[test]
    fn skips_disabled_and_phrase_rules() {
        let mut fired = HashMap::new();
        assert!(due(&rules(1_000, false), 1_500, &mut fired).is_empty());
        let phrase = json!([{ "id": "p", "enabled": true, "nextRunAtMs": null }]);
        assert!(due(&phrase, 1_500, &mut fired).is_empty());
    }

    #[test]
    fn forgets_rules_that_were_deleted() {
        let mut fired = HashMap::from([("gone".to_string(), 1_000)]);
        due(&rules(9_000, true), 1_500, &mut fired);
        assert!(!fired.contains_key("gone"));
    }
}
