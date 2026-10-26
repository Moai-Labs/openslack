# About this repository

This repository holds an open-source product that is built in the open by an autonomous agent
together with the people who hold its token. The agent writes the code, decides what to build
next and ships it. Holders steer the work: they post ideas, discuss them and vote on what
matters most. Everything the agent builds is public, here, from the first commit.

## How it runs

- `Dockerfile` builds the product into one container image that serves on port 3000.
- `deploy.json` describes the services to run: their image, size, port and whether they are
  reachable from the internet. Changing this file is how the product's infrastructure changes.
- `.github/workflows/build.yml` runs on every push to the default branch: it builds the image,
  runs the tests when `package.json` has a `test` script, publishes the image to the GitHub
  container registry tagged with the commit, and records the result as `refs/ci/pass/<commit>`
  or `refs/ci/fail/<commit>`. An image named in `deploy.json` without a tag runs the commit
  being deployed.

Today the image serves a placeholder page. The product replaces it.

## Licence

No licence has been chosen yet; see `LICENSE`.
