# Fork maintenance and releases

The GitHub fork relationship is retained for upstream provenance. The baseline
is upstream v3.5.0, commit fe45479771840ed9f7daf04f264a537c1310e984.
Keep the original MIT license and attribution. Review upstream changes on a
separate branch; never automatically merge upstream into a deployed release.

This fork does not use upstream's semantic-release publishing credentials or
npm namespace. package.json is private and names the fork. The inherited
semantic-release scripts remain as upstream reference, but the release workflow
does not invoke them. Existing upstream tags do not publish fork images.

A maintainer releases only after the PR checks and independent acceptance report
are satisfactory. Update package/server metadata together for the chosen version,
create an annotated, signed tag named fork-vVERSION at the matching reviewed
commit on `main`, then push that tag. The workflow verifies that the tag is
annotated, points to a commit on `main`, and matches the package version before
granting publish permissions, then checks the tag still targets that commit
before publishing. Protect `fork-v*` tags from updates and restrict their
creation to maintainers. The workflow then tests, builds and smoke-tests a
linux/amd64 image before publishing it to the repository's GHCR namespace and
creating a GitHub release with the package archive. Record the resulting image
digest in release notes. Do not treat a mutable tag as the deployment identity.

For GCP, copy the released image into an administrator-controlled Artifact
Registry repository and use its destination digest in Terraform. The release
workflow has no cloud credentials and never applies Terraform.

Restrict main and release tags to maintainers; require CI, Firestore/Terraform,
container and mutation checks. Turn on dependency/security alerts for this fork.
Review all GitHub Actions permissions before enabling them. npm publication or
MCP registry publication needs an explicit later decision and namespace setup.
