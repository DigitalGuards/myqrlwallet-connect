# Releasing the SDK packages

The manual `Publish npm packages` workflow publishes both packages under the
`next` distribution tag. It never changes `latest`.

## One-time npm configuration

Configure a trusted publisher separately for `@qrlwallet/connect` and
`@qrlwallet/connect-ui` in the npm package settings:

- Provider: GitHub Actions
- Organization: `DigitalGuards`
- Repository: `myqrlwallet-connect`
- Workflow filename: `publish.yml`
- Environment: leave blank
- Allowed action: `npm publish`

The workflow uses GitHub OIDC and must not be given an `NPM_TOKEN`. See npm's
[trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/)
for the registry-side setup.

## Publish a candidate

1. Merge the audited version changes to `main` and wait for CI to pass.
2. Run the `Publish npm packages` workflow from `main`.
3. Enter the exact SDK and UI versions from their package manifests.
4. Enter `publish-next` as the confirmation value.
5. Verify the workflow's final registry integrity and `next` tag checks.

The workflow uses exact action and npm CLI versions, performs clean installs,
runs all SDK and UI quality gates, packs exact tarballs, and publishes those
tarballs. A rerun accepts an existing version only when its registry integrity
matches the locally packed artifact.

Test the `next` releases in controlled wallet and dApp consumers before moving
either package's `latest` tag. npm OIDC does not authorize distribution-tag
updates, so promotion requires an authenticated maintainer action with 2FA.
