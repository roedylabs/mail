//! Request with several method calls and its response (RFC 8620, 3.3 and 3.4).

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::{Error, error::kind_of};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    using: Vec<&'static str>,
    method_calls: Vec<(String, Value, String)>,
}

/// ID of a method call in a [`Request`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallId(String);

impl Request {
    pub fn new(using: &[&'static str]) -> Self {
        Self {
            using: using.to_vec(),
            method_calls: Vec::new(),
        }
    }

    /// Appends a call; its ID is its position in the request.
    pub fn call(&mut self, method: &str, arguments: Value) -> CallId {
        let id = self.method_calls.len().to_string();
        self.method_calls
            .push((method.to_owned(), arguments, id.clone()));
        CallId(id)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    method_responses: Vec<(String, Value, String)>,
}

#[derive(Deserialize)]
struct MethodError {
    #[serde(rename = "type")]
    kind: String,
}

impl Response {
    /// The response `method` to the call `id`. A call can have several
    /// responses (`EmailSubmission/set` is followed by the implicit
    /// `Email/set`, RFC 8621, 7.5); a method error with this ID before it
    /// becomes [`Error::Method`].
    pub fn get<T: DeserializeOwned>(&self, id: &CallId, method: &str) -> Result<T, Error> {
        for (name, arguments, call_id) in &self.method_responses {
            if *call_id != id.0 {
                continue;
            }
            if name == "error" {
                let kind = MethodError::deserialize(arguments)
                    .map(|error| kind_of(&error.kind))
                    .unwrap_or_else(|_| "unknown".into());
                return Err(Error::Method(kind));
            }
            if name == method {
                return T::deserialize(arguments).map_err(|_| Error::InvalidResponse);
            }
        }
        Err(Error::InvalidResponse)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{CORE, MAIL};

    #[test]
    fn calls_are_numbered() {
        let mut request = Request::new(&[CORE, MAIL]);
        let first = request.call("Identity/get", json!({ "accountId": "a" }));
        let second = request.call("Mailbox/get", json!({ "accountId": "a" }));
        assert_eq!(first, CallId("0".into()));
        assert_eq!(second, CallId("1".into()));
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            json!({
                "using": [CORE, MAIL],
                "methodCalls": [
                    ["Identity/get", { "accountId": "a" }, "0"],
                    ["Mailbox/get", { "accountId": "a" }, "1"],
                ],
            })
        );
    }

    #[test]
    fn finds_responses_and_method_errors() {
        let response: Response = serde_json::from_value(json!({
            "methodResponses": [
                ["Email/set", { "created": {} }, "0"],
                ["EmailSubmission/set", { "created": {} }, "1"],
                ["error", { "type": "forbidden" }, "1"],
                ["error", { "type": "x y" }, "2"],
            ],
            "sessionState": "1",
        }))
        .unwrap();
        let get = |id: &str, method| response.get::<Value>(&CallId(id.into()), method);
        assert_eq!(get("0", "Email/set").unwrap(), json!({ "created": {} }));
        assert_eq!(
            get("1", "EmailSubmission/set").unwrap(),
            json!({ "created": {} })
        );
        // The implicit `Email/set` failed.
        assert_eq!(
            get("1", "Email/set"),
            Err(Error::Method("forbidden".into()))
        );
        assert_eq!(get("2", "Email/set"), Err(Error::Method("unknown".into())));
        assert_eq!(get("3", "Email/set"), Err(Error::InvalidResponse));
        assert_eq!(
            response.get::<Vec<String>>(&CallId("0".into()), "Email/set"),
            Err(Error::InvalidResponse)
        );
    }
}
