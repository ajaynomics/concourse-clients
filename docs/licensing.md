# Licences and provenance

Concourse-authored client code uses the [MIT licence](../LICENSE).
Third-party components retain their own licences. [NOTICE](../NOTICE) and the
runtime's full notices form part of this distribution.

## Qualified Pi runtime

The seven unchanged Pi 1.4.0 archives are recorded in
`pi/vendor/pi-140-input-preparation-5f7cade8/manifest.json`, with source commit
`5f7cade86e49811fada9599833a72ca3da4c5852`, the preparation patch, upstream MIT
copyright and bundled dependency notices. Installation verifies the locked
integrities; it does not silently select a global or stock replacement.

The archive review covered 2,541 regular-file members, source maps, five images,
and printable path strings in native/WASM files. It found no confirmed Concourse
credentials or private correspondence. This bounded review is not a guarantee
that a future source tree is free of secrets.

The five images and `examples/extensions/overlay-qa-tests.ts` containing demo
conversations/paths match the public upstream
[Pi coding-agent 1.4.0 package](https://registry.npmjs.org/@earendil-works/pi-coding-agent/1.4.0)
byte-for-byte. The official archive SHA256 is
`d155c16ef6fa00960fbf58b2911536e80b05f33700e0b14fbd08967ede0c7428`.
These are upstream examples, not exported Concourse conversations.

## proxy-agent-negotiate notice provenance

The exact [npm release](https://registry.npmjs.org/proxy-agent-negotiate/1.1.0)
and [package-specific source declaration](https://raw.githubusercontent.com/TooTallNate/proxy-agents/b7e5f7ccce1a3ac5b339cc4c587974e8989cbc16/packages/negotiate/package.json)
explicitly identify `MIT` and author Nathan Rajlich. The source-declaration
SHA256 is `22afa667fffb3ada1f7d56955ed59f396936f80c55ce09a229fe0afb3247c77a`.

The release tag and npm's decoded provenance identify source commit
`b7e5f7ccce1a3ac5b339cc4c587974e8989cbc16`. Provenance digests were correlated;
attestation signatures were not independently verified.

The published tarball SHA256 is
`6eec23d5d381a8b0ffafe91c19876d3a052e463618695981a7529f3a8bca1997`.
Its five files include no licence/notice. The release source has no root or
negotiate-specific full licence either.

The preserved full [MIT notice](https://raw.githubusercontent.com/TooTallNate/proxy-agents/b7e5f7ccce1a3ac5b339cc4c587974e8989cbc16/packages/proxy-agent/LICENSE)
is from the same author's sibling package at that exact source commit, with
its original 2013 copyright. Its SHA256 is
`8d8c55319c7729d57be811c747452636688d54f19701ee0752b6b15ad3771d9a`.
No upstream statement establishes that copyright line as negotiate-specific.

**Distribution decision:** retain the unchanged full notice and disclose its
provenance. Rely on the package-specific MIT declaration for the applicable
licence; do not represent the sibling notice as newly proven applicable.
This closes the packaging hold on that stated basis, not by asserting an absent
licence file exists or by granting rights on an upstream author's behalf.
