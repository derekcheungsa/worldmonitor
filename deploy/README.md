# Deploy contexts for Railway templates

Railway templates can only set a service rootDirectory, not a custom dockerfile
path, so each of these directories carries a default `Dockerfile` that builds
the right image from a fresh clone of this fork. If you fork this repo, pass
`--build-arg REPO=<your fork> --build-arg BRANCH=<your branch>`.
