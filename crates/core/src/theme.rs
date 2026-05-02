//! Minimal theme-token contract shared by CLI/core and GUI surfaces.

use serde::{Deserialize, Serialize};

pub const THEME_SCHEMA_VERSION: &str = "pccx.lab.theme-tokens.v0";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeTokenContract {
    pub schema_version: String,
    pub token_slots: Vec<String>,
    pub presets: Vec<ThemePreset>,
    pub limitations: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemePreset {
    pub name: String,
    pub description: String,
    pub tokens: ThemeTokens,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeTokens {
    pub background: String,
    pub foreground: String,
    pub muted_foreground: String,
    pub border: String,
    pub panel_background: String,
    pub accent: String,
    pub danger: String,
    pub warning: String,
    pub success: String,
}

fn tokens(
    background: &str,
    foreground: &str,
    muted_foreground: &str,
    border: &str,
    panel_background: &str,
    accent: &str,
    danger: &str,
    warning: &str,
    success: &str,
) -> ThemeTokens {
    ThemeTokens {
        background: background.to_string(),
        foreground: foreground.to_string(),
        muted_foreground: muted_foreground.to_string(),
        border: border.to_string(),
        panel_background: panel_background.to_string(),
        accent: accent.to_string(),
        danger: danger.to_string(),
        warning: warning.to_string(),
        success: success.to_string(),
    }
}

pub fn theme_presets() -> Vec<ThemePreset> {
    vec![
        ThemePreset {
            name: "native-light".to_string(),
            description: "Neutral light preset for host-native chrome.".to_string(),
            tokens: tokens(
                "#f7f7f8", "#1f2328", "#667085", "#d0d5dd", "#ffffff", "#2f6fed", "#c2410c",
                "#a16207", "#15803d",
            ),
        },
        ThemePreset {
            name: "native-dark".to_string(),
            description: "Neutral dark preset for host-native chrome.".to_string(),
            tokens: tokens(
                "#1f2023", "#e6e8eb", "#9aa4b2", "#3f444d", "#292b30", "#6aa6ff", "#f97316",
                "#eab308", "#22c55e",
            ),
        },
        ThemePreset {
            name: "compact-dark".to_string(),
            description: "Dense dark preset for compact verification panels.".to_string(),
            tokens: tokens(
                "#17191c", "#e4e7ec", "#98a2b3", "#333741", "#202329", "#7dd3fc", "#fb7185",
                "#fbbf24", "#34d399",
            ),
        },
        ThemePreset {
            name: "quiet-light".to_string(),
            description: "Low-contrast light preset for quiet engineering UI.".to_string(),
            tokens: tokens(
                "#fafafa", "#24292f", "#6b7280", "#d9dee7", "#f3f4f6", "#3861d6", "#b42318",
                "#b54708", "#027a48",
            ),
        },
    ]
}

pub fn theme_preset_names() -> Vec<String> {
    theme_presets()
        .into_iter()
        .map(|preset| preset.name)
        .collect()
}

pub fn theme_contract() -> ThemeTokenContract {
    ThemeTokenContract {
        schema_version: THEME_SCHEMA_VERSION.to_string(),
        token_slots: vec![
            "background".to_string(),
            "foreground".to_string(),
            "mutedForeground".to_string(),
            "border".to_string(),
            "panelBackground".to_string(),
            "accent".to_string(),
            "danger".to_string(),
            "warning".to_string(),
            "success".to_string(),
        ],
        presets: theme_presets(),
        limitations: vec![
            "Theme presets are experimental and may change before a stable UI contract."
                .to_string(),
            "Presets define semantic slots only; component-level styling remains in the GUI."
                .to_string(),
        ],
    }
}

pub fn theme_contract_json_pretty() -> serde_json::Result<String> {
    serde_json::to_string_pretty(&theme_contract())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_contract_has_required_slots() {
        let contract = theme_contract();
        let slots = contract.token_slots;
        for slot in [
            "background",
            "foreground",
            "mutedForeground",
            "border",
            "panelBackground",
            "accent",
            "danger",
            "warning",
            "success",
        ] {
            assert!(slots.iter().any(|s| s == slot), "missing slot {slot}");
        }
    }

    #[test]
    fn theme_presets_are_named_and_complete() {
        let names = theme_preset_names();
        assert_eq!(
            names,
            vec!["native-light", "native-dark", "compact-dark", "quiet-light"]
        );

        for preset in theme_presets() {
            assert!(preset.tokens.background.starts_with('#'));
            assert!(preset.tokens.foreground.starts_with('#'));
            assert!(preset.tokens.panel_background.starts_with('#'));
            assert!(preset.tokens.accent.starts_with('#'));
        }
    }

    #[test]
    fn theme_contract_serializes_deterministically() {
        let first = theme_contract_json_pretty().unwrap();
        let second = theme_contract_json_pretty().unwrap();
        assert_eq!(first, second);
    }
}
