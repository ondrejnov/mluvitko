const { shell } = require('electron')
const http = require('http')
const crypto = require('crypto')
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args))

// Zástupné hodnoty pro Google OAuth (Desktop App)
const GOOGLE_CLIENT_ID = 'VÁŠ_GOOGLE_CLIENT_ID.apps.googleusercontent.com'
const GOOGLE_CLIENT_SECRET = 'VÁŠ_GOOGLE_CLIENT_SECRET' // Pro desktop aplikace je secret v pořádku, nebo použijte PKCE bez secretu
const REDIRECT_URI = 'http://127.0.0.1:53214'

function base64URLEncode(str) {
  return str.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest()
}

async function loginWithGoogle() {
  return new Promise((resolve, reject) => {
    const codeVerifier = base64URLEncode(crypto.randomBytes(32))
    const codeChallenge = base64URLEncode(sha256(codeVerifier))

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`)
        if (url.pathname === '/') {
          const code = url.searchParams.get('code')
          const error = url.searchParams.get('error')

          if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<h1>Chyba přihlášení</h1><p>Můžete zavřít toto okno.</p>')
            server.close()
            reject(new Error(error))
            return
          }

          if (code) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<h1>Přihlášení úspěšné!</h1><p>Můžete zavřít toto okno a vrátit se do aplikace.</p>')
            server.close()

            // Výměna kódu za tokeny
            const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                client_id: GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                code,
                code_verifier: codeVerifier,
                redirect_uri: REDIRECT_URI,
                grant_type: 'authorization_code'
              })
            })

            const tokenData = await tokenResponse.json()
            if (tokenData.error) {
              reject(new Error(tokenData.error_description || tokenData.error))
            } else {
              resolve(tokenData) // Obsahuje id_token, access_token, atd.
            }
          }
        }
      } catch (err) {
        res.writeHead(500)
        res.end('Internal Server Error')
        server.close()
        reject(err)
      }
    })

    server.listen(53214, '127.0.0.1', () => {
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=openid%20email%20profile&code_challenge=${codeChallenge}&code_challenge_method=S256`
      shell.openExternal(authUrl)
    })

    // Timeout po 5 minutách
    setTimeout(() => {
      if (server.listening) {
        server.close()
        reject(new Error('Timeout přihlášení'))
      }
    }, 5 * 60 * 1000)
  })
}

module.exports = { loginWithGoogle }
