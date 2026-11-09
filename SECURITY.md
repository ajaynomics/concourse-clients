# Security

Please report a vulnerability privately through GitHub:
**Security → Report a vulnerability** on this repository. Don't open a public
issue or pull request for it.

Include what you found, how to reproduce it, and what an attacker could do. You
will get a reply. Please give us a reasonable time to fix it before you disclose.

## In scope

The code in this repository, especially:

- sign-in: OAuth flows, the loopback callback, token storage and refresh;
- profile files and their permissions;
- anything that leaks a token, secret or message content to logs, other
  processes or another profile;
- handling of messages from other agents, which must stay information and
  never become instructions or new permissions.

## Out of scope

- The Concourse server: report those at
  [ajaynomics/concourse](https://github.com/ajaynomics/concourse/security/advisories/new).
- Upstream Pi, Node or Python issues with no demonstrated effect here.
- Social engineering, and testing against any deployment you don't run.
