//! Storage of an account via `Quota/get` (RFC 9425): "Check connection" on the
//! mail account overview shows how much of the storage is used.

use serde::Deserialize;
use serde_json::json;

use crate::{CORE, Client, Error, Request};

/// Capability for quotas (RFC 9425, 3).
pub const QUOTA: &str = "urn:ietf:params:jmap:quota";

/// Used and available storage in bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Storage {
    pub used: u64,
    pub total: u64,
}

/// The fields of a quota object (RFC 9425, 4) the client needs.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Quota {
    resource_type: String,
    used: u64,
    hard_limit: u64,
    #[serde(default)]
    types: Vec<String>,
}

#[derive(Deserialize)]
struct List<T> {
    list: Vec<T>,
}

/// The quota that fills up first for mails: storage (`octets`) for the
/// type `Email` with the least free space – usually the account's,
/// otherwise e.g. the domain's. Without such a quota `None` (no limit).
fn storage(quotas: &[Quota]) -> Option<Storage> {
    quotas
        .iter()
        .filter(|quota| {
            quota.resource_type == "octets" && quota.types.iter().any(|kind| kind == "Email")
        })
        .min_by_key(|quota| quota.hard_limit.saturating_sub(quota.used))
        .map(|quota| Storage {
            used: quota.used,
            total: quota.hard_limit,
        })
}

impl Client {
    /// Storage of the account according to `Quota/get`; `None` if the server
    /// offers no quotas for the account (no capability, no primary account for
    /// it, method errors like `accountNotSupportedByMethod`) or sets no limit
    /// for mails (Stalwart then returns an empty list). The connection still
    /// counts as working then.
    pub async fn storage(&self) -> Result<Option<Storage>, Error> {
        let Some(account_id) = self.session().primary_account(QUOTA) else {
            return Ok(None);
        };
        let mut request = Request::new(&[CORE, QUOTA]);
        let call = request.call("Quota/get", json!({ "accountId": account_id, "ids": null }));
        let response = self.call(&request).await?;
        match response.get::<List<Quota>>(&call, "Quota/get") {
            Ok(quotas) => Ok(storage(&quotas.list)),
            Err(Error::Method(_)) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quota(resource_type: &str, used: u64, hard_limit: u64, types: &[&str]) -> Quota {
        Quota {
            resource_type: resource_type.into(),
            used,
            hard_limit,
            types: types.iter().map(|&kind| kind.into()).collect(),
        }
    }

    #[test]
    fn reads_the_quota_of_stalwart() {
        // Response of Stalwart v1.0.2 for an account with 100 MiB.
        let list: List<Quota> = serde_json::from_value(json!({
            "accountId": "c",
            "state": "n",
            "list": [{
                "id": "a", "resourceType": "octets", "used": 2048, "warnLimit": null,
                "softLimit": null, "hardLimit": 104_857_600, "scope": "account",
                "name": "user@example.test", "description": "Test account",
                "types": ["Email", "SieveScript", "FileNode", "CalendarEvent", "ContactCard"],
            }],
            "notFound": [],
        }))
        .unwrap();
        assert_eq!(
            storage(&list.list),
            Some(Storage {
                used: 2048,
                total: 104_857_600
            })
        );
    }

    #[test]
    fn picks_the_storage_quota_that_fills_first() {
        assert_eq!(storage(&[]), None);
        let quotas = [
            // The number of mails and storage for other types do not count.
            quota("count", 9, 10, &["Email"]),
            quota("octets", 9, 10, &["FileNode"]),
            quota("octets", 1, 100, &["Email"]),
            quota("octets", 950, 1000, &["Email", "FileNode"]),
        ];
        assert_eq!(
            storage(&quotas),
            Some(Storage {
                used: 950,
                total: 1000
            })
        );
        assert_eq!(storage(&quotas[..2]), None);
        // Exceeded: no free space.
        let over = [quota("octets", 120, 100, &["Email"]), quotas[3].clone()];
        assert_eq!(storage(&over).map(|s| s.used), Some(120));
    }
}
