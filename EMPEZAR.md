# Puesta en marcha con Supabase + Vercel

Mismo stack que la app de delivery. Son cuatro pasos y no hace falta terminal:
Supabase guarda los datos y las fotos, Vercel corre la app, Claude lee los billetes.

Calcula unos 20 minutos la primera vez.

---

## 1. Supabase — la base de datos y las fotos

### 1.1 Crear el proyecto

En <https://supabase.com> → **New project**. Ponle un nombre (`dolares-por-caja`),
elige la región más cercana y **guarda la contraseña de la base de datos**: se
muestra una sola vez y la necesitas en el paso siguiente.

### 1.2 Copiar la cadena de conexión

**Project Settings → Database → Connection string.**

Elige la pestaña **Transaction** (puerto **6543**), no la de Session.
Esto importa: Vercel abre y cierra procesos todo el tiempo, y solo el modo
*transaction* del pooler aguanta ese patrón sin agotar las conexiones.

Copia esa cadena y sustituye `[YOUR-PASSWORD]` por la contraseña del paso 1.1.
Queda así:

```
postgresql://postgres.abcd1234:TU-CLAVE@aws-0-us-east-1.pooler.supabase.com:6543/postgres
```

### 1.3 Crear el bucket de las fotos

**Storage → New bucket:**

- Nombre: `billetes`
- **Public bucket: NO** (déjalo privado)

Privado significa que las fotos de los billetes no quedan expuestas en internet.
La app genera enlaces temporales firmados cada vez que hay que mostrar una.

### 1.4 Copiar las claves de la API

**Project Settings → API.** Necesitas dos cosas:

- **Project URL** → `https://xxxx.supabase.co`
- **service_role key** (la secreta, no la `anon`)

> La `service_role` salta las reglas de seguridad de Supabase. Va **solo** en las
> variables de entorno de Vercel, nunca en el navegador ni en un repositorio.
> Aquí es correcto usarla porque quien controla el acceso es la propia app, con
> sus usuarios y PIN.

**No hace falta que crees las tablas**: la app las crea sola la primera vez que
arranca. Si prefieres verlas antes, están en [`esquema.sql`](esquema.sql) y
puedes pegarlo en el editor SQL de Supabase.

---

## 2. Claude — la clave que lee los billetes

En <https://console.anthropic.com> → **API Keys** → **Create Key**.
Empieza por `sk-ant-` y **solo se muestra una vez**.

---

## 3. Vercel — publicar la app

1. En <https://vercel.com> → **Add New → Project** → importa el repositorio
   `Dolares-por-caja`.
2. **La rama importa.** El código está en `claude/dollars-received-database-gxgmwh`,
   y Vercel publica `main` por defecto. Si no lo cambias, la página principal
   responde **404: NOT_FOUND**. Lo más simple es hacer merge de esa rama a `main`
   en GitHub antes de desplegar; si prefieres no tocarla, ve a
   **Settings → Git → Production Branch** y ponla ahí.
3. **Framework Preset: Other.** No toques Build Command ni Output Directory:
   `vercel.json` ya lo tiene resuelto.
4. Despliega **Environment Variables** y añade estas cinco:

   | Nombre | Valor |
   |---|---|
   | `DATABASE_URL` | la cadena del paso 1.2 (puerto 6543) |
   | `SUPABASE_URL` | el Project URL del paso 1.4 |
   | `SUPABASE_SERVICE_ROLE_KEY` | la clave `service_role` del paso 1.4 |
   | `ANTHROPIC_API_KEY` | la clave del paso 2 |
   | `PIN_ADMIN` | el PIN que quieras para entrar la primera vez |

5. **Deploy.**

Cuando termine te da una dirección `https://...vercel.app`. Ábrela y entra con
usuario `admin` y el PIN que pusiste.

---

## 4. Lo primero que tienes que hacer dentro

1. **Ajustes → Cambiar mi PIN.** El PIN inicial está en las variables de Vercel,
   que ve cualquiera con acceso al proyecto.
2. **Ajustes → Cajeras:** añade a todas.
3. **Ajustes → Usuarios:** crea uno por cada persona que vaya a registrar fotos,
   con su propio PIN. Así cada registro queda con nombre y apellido.

### Instalarla en el teléfono

Abre la dirección de Vercel en el teléfono:

- **Android (Chrome):** menú ⋮ → *Instalar aplicación*.
- **iPhone (Safari):** botón compartir → *Añadir a pantalla de inicio*.

Queda con su icono y se abre a pantalla completa.

---

## Trabajar en local (opcional)

Si quieres cambiar algo antes de subirlo:

```bash
git clone https://github.com/pattialberto1/Dolares-por-caja.git
cd Dolares-por-caja
git checkout claude/dollars-received-database-gxgmwh
npm install
cp .env.example .env      # rellena los valores
npm start
```

Recomendación: crea un **segundo proyecto en Supabase** para desarrollo. Si
apuntas el `.env` local a la base de producción, cualquier prueba entra en los
datos reales del local.

Para trastear sin gastar saldo de la API, pon en el `.env`:

```
SIMULAR_LECTURA=1
```

Y para correr las pruebas (crean su propio esquema temporal y lo borran al
terminar, no tocan tus tablas):

```bash
DATABASE_URL_PRUEBA="postgresql://..." npm run prueba
```

---

## Qué cuesta esto al mes

| | Gratis hasta | Después |
|---|---|---|
| **Vercel** (Hobby) | uso personal, suficiente para esto | $20/mes (Pro) |
| **Supabase** (Free) | 500 MB de base + 1 GB de fotos | $25/mes (Pro, 8 GB + 100 GB) |
| **Claude API** | — se paga por uso | ~$0,025 por foto con `claude-opus-5` |

Las fotos ocupan ~350 KB cada una, así que **1 GB gratis ≈ 3.000 fotos**. A 100
fotos diarias eso es un mes. Cuando se acerque, o pasas Supabase a Pro, o
borras las fotos viejas (los seriales y las cajeras quedan igual en la base:
lo que se pierde es poder ver la imagen del billete).

El gasto real de Claude lo ves medido en la pestaña **Reportes**.

---

## Si algo falla

**Lo primero, siempre:** abre `https://tu-app.vercel.app/api/salud`. Te dice en
una línea qué pieza está fallando, sin exponer ninguna clave:

```json
{ "ok": false,
  "base_de_datos": "la conexión expiró — suele pasar al usar el puerto 5432 en vez del 6543",
  "almacen_fotos": "faltan variables",
  "clave_claude": "configurada" }
```

**404: NOT_FOUND en la página principal** — Vercel está sirviendo la rama
equivocada. Por defecto publica `main`, y el código está en
`claude/dollars-received-database-gxgmwh`. Dos salidas:

- **Vercel → Settings → Git → Production Branch** → cámbiala a esa rama y vuelve
  a desplegar (Deployments → ⋯ → Redeploy).
- O haz merge de la rama a `main` en GitHub, y Vercel despliega solo.

**"Falta DATABASE_URL"** — la variable no llegó a Vercel. Revisa que esté en
Settings → Environment Variables y **vuelve a desplegar**: Vercel no aplica
variables nuevas a un despliegue ya hecho.

**"too many connections" o timeouts raros** — estás usando el puerto 5432
(conexión directa) en vez del 6543 (pooler en modo transaction). Cámbialo.

**La foto se sube pero sale "error" al leer** — mira los logs en Vercel →
Deployments → el último → Functions. Casi siempre es la `ANTHROPIC_API_KEY` mal
copiada o sin saldo en la cuenta.

**La lectura tarda y se corta** — el límite de la función está en 60 segundos
(`vercel.json`). Si tus fotos son muy grandes, baja `MAX_LADO_PX` a 1400.

**Al subir una foto sale un error** — abre `/api/salud` y mira `almacen_fotos`.
Te dice cuál de estas cuatro es:

- *no existe un bucket llamado "billetes"* → créalo en Supabase → Storage, con
  ese nombre exacto y **privado**.
- *la clave no es válida* → copiaste la `anon` en vez de la `service_role`.
- *sin permiso sobre el bucket* → misma causa: falta la `service_role`.
- *no se pudo alcanzar Supabase* → revisa `SUPABASE_URL`.

Recuerda que después de tocar cualquier variable hay que **volver a desplegar**.
