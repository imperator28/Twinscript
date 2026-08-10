# Local model catalog artifacts

The three required production security artifacts are:

- `model-manifest.json`
- `model-manifest.sig`
- `model-manifest-public.pem`

Model downloads use app-controlled HTTPS URLs only. The private signing key and
model weights never enter this repository or a build worker.
