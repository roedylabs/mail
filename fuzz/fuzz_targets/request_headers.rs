//! Request headers every client controls: `X-Forwarded-For` (client IP for
//! rate limits and the audit log), `Cookie` (session) and `User-Agent`
//! (device list).

#![no_main]

use std::net::IpAddr;

use arbitrary::Arbitrary;
use axum::http::{HeaderMap, HeaderValue, header};
use libfuzzer_sys::fuzz_target;
use roedy_mail_server::{
    auth::{device::Device, session},
    client_ip::{ClientIp, resolve},
    config::TrustProxy,
    db::repo::sessions,
    settings::Language,
};

#[derive(Arbitrary, Debug)]
struct Input<'a> {
    peer: [u8; 16],
    ipv4: bool,
    hops: u8,
    forwarded: Vec<&'a [u8]>,
    cookies: Vec<&'a [u8]>,
    user_agent: Option<&'a str>,
    max_user_agent: u16,
}

fuzz_target!(|input: Input<'_>| {
    let peer = if input.ipv4 {
        IpAddr::from([input.peer[0], input.peer[1], input.peer[2], input.peer[3]])
    } else {
        IpAddr::from(input.peer)
    };
    let mut headers = HeaderMap::new();
    for value in input.forwarded {
        if let Ok(value) = HeaderValue::from_bytes(value) {
            headers.append("x-forwarded-for", value);
        }
    }
    for value in input.cookies {
        if let Ok(value) = HeaderValue::from_bytes(value) {
            headers.append(header::COOKIE, value);
        }
    }

    let trust = TrustProxy(input.hops % (TrustProxy::MAX + 1));
    let client = resolve(peer, &headers, trust);
    if !trust.enabled() {
        assert_eq!(client, peer.to_canonical());
    }
    let _ = ClientIp(client).network();

    for name in [session::COOKIE, "other"] {
        if let Some(value) = session::named_cookie(&headers, name) {
            assert!(!value.contains(';'));
            let _ = session::Token::parse(value);
        }
    }

    if let Some(user_agent) = input.user_agent {
        let max = usize::from(input.max_user_agent);
        let truncated = sessions::truncate(user_agent, max);
        assert!(truncated.len() <= max && user_agent.starts_with(truncated));
    }
    let device = Device::parse(input.user_agent);
    for lang in [Language::English, Language::German] {
        assert!(!device.label(lang).is_empty());
    }
});
