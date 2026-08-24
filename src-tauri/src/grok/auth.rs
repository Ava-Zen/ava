use serde_json::Value;

use crate::grok::types::AuthStatus;

/// Current Grok ACP advertises login methods on `initialize`. Without an
/// active credential there is exactly one interactive method.
pub fn interactive_method(initialize: &Value) -> Result<String, String> {
    let methods = initialize
        .get("authMethods")
        .and_then(Value::as_array)
        .ok_or("initialize omitted authMethods")?;
    methods
        .iter()
        .filter_map(|method| method.get("id").and_then(Value::as_str))
        .find(|id| !matches!(*id, "cached_token" | "xai.api_key"))
        .map(str::to_string)
        .ok_or_else(|| "Grok did not advertise an interactive auth method".into())
}

pub fn status_from_info(info: &Value) -> AuthStatus {
    let method_id = info.get("methodId").and_then(Value::as_str);
    let email = text(info, "email");
    let principal_id = text(info, "principalId");
    let signed_in = method_id == Some("xai.api_key") || email.is_some() || principal_id.is_some();
    let first = text(info, "firstName");
    let last = text(info, "lastName");
    let name = match (first, last) {
        (Some(first), Some(last)) => Some(format!("{first} {last}")),
        (Some(first), None) => Some(first),
        (None, Some(last)) => Some(last),
        (None, None) => None,
    };
    AuthStatus {
        signed_in,
        message: if signed_in {
            email.clone().unwrap_or_else(|| "signed in".into())
        } else {
            "signed out".into()
        },
        email,
        name,
    }
}

pub fn login_url(response: &Value) -> Result<String, String> {
    response
        .get("auth_url")
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty())
        .map(str::to_string)
        .ok_or("Grok did not return a login URL".into())
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn chooses_the_one_current_interactive_method() {
        let initialize = json!({
            "authMethods": [
                { "id": "xai.api_key" },
                { "id": "cached_token" },
                { "id": "grok.com" }
            ]
        });
        assert_eq!(interactive_method(&initialize).unwrap(), "grok.com");
    }

    #[test]
    fn auth_info_is_the_only_status_source() {
        let status = status_from_info(&json!({
            "methodId": "cached_token",
            "email": "lynn@example.com",
            "firstName": "Lynn",
            "lastName": "Zhao"
        }));
        assert!(status.signed_in);
        assert_eq!(status.email.as_deref(), Some("lynn@example.com"));
        assert_eq!(status.name.as_deref(), Some("Lynn Zhao"));

        assert!(!status_from_info(&json!({ "methodId": null })).signed_in);
        assert!(status_from_info(&json!({ "methodId": "xai.api_key" })).signed_in);
        assert!(!status_from_info(&json!({ "methodId": "cached_token" })).signed_in);
    }

    #[test]
    fn login_url_requires_the_current_wire_field() {
        assert_eq!(
            login_url(&json!({ "auth_url": "https://accounts.x.ai/login" })).unwrap(),
            "https://accounts.x.ai/login"
        );
        assert!(login_url(&json!({ "url": "https://old.example" })).is_err());
    }
}
