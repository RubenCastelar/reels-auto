# Reels Auto

Comentario con palabra clave en un reel → mensaje privado con botón → al pulsarlo se comprueba que te sigue → se envía tu mensaje con el enlace.

- `docs/` → panel web (GitHub Pages: Settings → Pages → Branch `main`, carpeta `/docs`).
- `worker/` → backend gratuito en Cloudflare Workers.

## Desplegar el backend

```bash
cd worker
npx wrangler login
npx wrangler kv namespace create RULES      # copia el id a wrangler.toml
npx wrangler secret put IG_TOKEN            # token de Instagram
npx wrangler secret put IG_USER_ID          # id numérico de tu cuenta de Instagram
npx wrangler secret put APP_SECRET          # secreto de la app de Meta
npx wrangler secret put VERIFY_TOKEN        # una palabra inventada, la usarás en el webhook de Meta
npx wrangler secret put ADMIN_PASSWORD      # contraseña del panel
npx wrangler deploy
```

Webhook en Meta: `https://reels-auto.TU-USUARIO.workers.dev/webhook`, verify token = `VERIFY_TOKEN`,
campos `comments` y `messages` (incluye `messaging_postbacks`).

Los tokens van solo como secretos de Cloudflare, nunca en GitHub.
