# Local model catalog artifacts

Production catalogs contain exactly these three files:

- `model-manifest.json`
- `model-manifest.sig`
- `model-manifest-public.pem`

Model downloads use app-controlled HTTPS URLs only. The private signing key and
model weights never enter this repository or a build worker.
