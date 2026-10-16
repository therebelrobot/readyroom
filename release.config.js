// Release configuration for semantic-release.
//
// semantic-release reads this before it changes anything, so the package.json
// we read here still holds the version of the last release. That tells us
// whether we are still pre-1.0.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const preOnePointOh = Number(pkg.version.split(".")[0]) === 0;

// Stock semantic-release bumps a BREAKING CHANGE to major, which while we are
// on 0.x would jump straight to 1.0.0. So until the first release with major
// >= 1, downgrade a breaking change to a minor bump. The 0.x -> 1.0 step is
// then deliberate: run `npm run release:major` when you mean it, and from the
// next release on this rule is gone and breaking changes bump major again.
const commitAnalyzer = preOnePointOh
  ? [
      "@semantic-release/commit-analyzer",
      { releaseRules: [{ breaking: true, release: "minor" }] },
    ]
  : "@semantic-release/commit-analyzer";

export default {
  branches: ["main"],
  plugins: [
    commitAnalyzer,
    "@semantic-release/release-notes-generator",
    ["@semantic-release/changelog", { changelogFile: "CHANGELOG.md" }],
    ["@semantic-release/npm", { npmPublish: false }],
    "@semantic-release/github",
    [
      "@semantic-release/git",
      {
        assets: ["CHANGELOG.md", "package.json", "package-lock.json"],
        message: "chore(release): v${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
      },
    ],
  ],
};
