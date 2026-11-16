//! Small GeoIP database in MaxMind DB format (specification 2.0, IPv4,
//! 24-bit records) for tests: per network a city and a country with names
//! in several languages, as GeoLite2-City provides them.

#![allow(dead_code, reason = "not every test file uses everything")]

use std::net::Ipv4Addr;

/// A network with city (`None` = country only) and country.
pub struct Entry {
    pub network: Ipv4Addr,
    pub prefix: u8,
    pub city: Option<&'static str>,
    pub country: &'static str,
}

#[derive(Clone, Copy)]
enum Record {
    Empty,
    Node(usize),
    Data(usize),
}

pub fn build(entries: &[Entry]) -> Vec<u8> {
    build_typed(entries, "Roedy-Test-City")
}

/// Like [`build`] with its own `database_type` (e.g. `GeoLite2-ASN`).
pub fn build_typed(entries: &[Entry], database_type: &str) -> Vec<u8> {
    let mut nodes = vec![[Record::Empty; 2]];
    let mut data = Vec::new();
    for entry in entries {
        let offset = data.len();
        data.extend(record(entry));
        let ip = u32::from(entry.network);
        let mut node = 0;
        for i in 0..entry.prefix {
            let bit = usize::from((ip >> (31 - i)) & 1 == 1);
            if i + 1 == entry.prefix {
                nodes[node][bit] = Record::Data(offset);
            } else if let Record::Node(next) = nodes[node][bit] {
                node = next;
            } else {
                nodes.push([Record::Empty; 2]);
                let next = nodes.len() - 1;
                nodes[node][bit] = Record::Node(next);
                node = next;
            }
        }
    }

    let count = u32::try_from(nodes.len()).unwrap();
    let mut out = Vec::new();
    for node in &nodes {
        for record in node {
            let value = match *record {
                Record::Empty => count,
                Record::Node(n) => u32::try_from(n).unwrap(),
                Record::Data(offset) => count + 16 + u32::try_from(offset).unwrap(),
            };
            out.extend_from_slice(&value.to_be_bytes()[1..]);
        }
    }
    out.extend([0; 16]);
    out.extend(data);
    out.extend(b"\xAB\xCD\xEFMaxMind.com");
    out.extend(map(&[
        ("binary_format_major_version", uint(5, 2)),
        ("binary_format_minor_version", uint(5, 0)),
        ("build_epoch", uint64(1_760_000_000)),
        ("database_type", string(database_type)),
        ("description", map(&[("en", string("Test"))])),
        ("ip_version", uint(5, 4)),
        ("languages", array(&[string("de"), string("en")])),
        ("node_count", uint(6, count.into())),
        ("record_size", uint(5, 24)),
    ]));
    out
}

fn record(entry: &Entry) -> Vec<u8> {
    let names = |name: &str| map(&[("names", map(&[("de", string(name)), ("en", string(name))]))]);
    let mut fields = vec![("country", names(entry.country))];
    if let Some(city) = entry.city {
        fields.insert(0, ("city", names(city)));
    }
    map(&fields)
}

/// Control byte with type (1–7) and size.
fn control(kind: u8, size: usize) -> Vec<u8> {
    match size {
        0..29 => vec![(kind << 5) | u8::try_from(size).unwrap()],
        29..285 => vec![(kind << 5) | 29, u8::try_from(size - 29).unwrap()],
        _ => panic!("too large for the test"),
    }
}

fn string(value: &str) -> Vec<u8> {
    let mut out = control(2, value.len());
    out.extend(value.as_bytes());
    out
}

/// `uint16` (type 5) or `uint32` (type 6), as short as possible.
fn uint(kind: u8, value: u64) -> Vec<u8> {
    let bytes: Vec<u8> = value
        .to_be_bytes()
        .into_iter()
        .skip_while(|b| *b == 0)
        .collect();
    let mut out = control(kind, bytes.len());
    out.extend(bytes);
    out
}

/// `uint64` is an extended type (9 = 7 + 2).
fn uint64(value: u64) -> Vec<u8> {
    let mut out = uint(0, value);
    out.insert(1, 2);
    out
}

fn map(pairs: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut out = control(7, pairs.len());
    for (key, value) in pairs {
        out.extend(string(key));
        out.extend(value);
    }
    out
}

/// Arrays are an extended type (11 = 7 + 4).
fn array(items: &[Vec<u8>]) -> Vec<u8> {
    let mut out = control(0, items.len());
    out.insert(1, 4);
    for item in items {
        out.extend(item);
    }
    out
}
