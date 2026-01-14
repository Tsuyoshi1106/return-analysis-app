export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    message: "WHOAMI from web/pages/api/_whoami.js",
    now: new Date().toISOString(),
  });
}
