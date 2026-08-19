# Cómo abrirlo en el teléfono

Para que la app se abra en el teléfono tiene que estar **corriendo en algún lado**.
Hay dos caminos. Empieza por el A para verla hoy; el B es para el uso diario.

---

## Camino A — Verla hoy, desde la computadora del local (15 minutos, gratis)

El teléfono se conecta a la computadora por el WiFi del local. No hace falta
contratar nada ni crear cuentas.

### 1. Instalar Node.js

Ve a <https://nodejs.org> y descarga la versión que dice **LTS**.
Instalador siguiente-siguiente-siguiente. Es lo único que hay que instalar.

### 2. Abrir la terminal

- **Windows:** tecla Windows → escribe `powershell` → Enter.
- **Mac:** Cmd + Espacio → escribe `terminal` → Enter.

Es una ventana negra donde se escriben comandos. Vas a copiar y pegar.

### 3. Bajar la app

Pega esto y dale Enter (una línea a la vez):

```bash
git clone https://github.com/pattialberto1/Dolares-por-caja.git
cd Dolares-por-caja
git checkout claude/dollars-received-database-gxgmwh
npm install
```

`npm install` tarda un par de minutos. Es normal que salga mucho texto.

> Si `git` no existe en tu computadora, bájalo de <https://git-scm.com> e
> instálalo, o descarga el ZIP desde GitHub y descomprímelo.

### 4. Poner la clave de Claude

Entra a <https://console.anthropic.com> → **API Keys** → **Create Key**.
Copia la clave (empieza por `sk-ant-`). **Solo se ve una vez.**

En la carpeta de la app hay un archivo llamado `.env.example`. Haz una copia
llamada `.env` y ábrela con el Bloc de notas. Cambia la línea de la clave:

```
ANTHROPIC_API_KEY=sk-ant-aqui-va-tu-clave
```

Guarda y cierra.

### 5. Encenderla

```bash
npm start
```

Te va a salir algo así:

```
  ┌─────────────────────────────────────────────
  │  Dólares por caja está funcionando
  ├─────────────────────────────────────────────
  │  En esta computadora:  http://localhost:3000
  │  En el teléfono:       http://192.168.1.50:3000
  └─────────────────────────────────────────────

  Se creó el usuario "admin" con PIN 1234.
```

### 6. Abrirla en el teléfono

Con el teléfono **en el mismo WiFi**, abre el navegador y escribe la dirección
que dice **"En el teléfono"** (la tuya, no la del ejemplo). Entra con usuario
`admin` y el PIN que aparece.

**Lo primero que tienes que hacer:** Ajustes → cambia el PIN de admin, añade
las cajeras y crea un usuario con su PIN para cada persona que vaya a registrar.

### Si el teléfono no abre la página

- **Windows te va a preguntar por el firewall** la primera vez. Dale *Permitir*.
  Si ya le diste que no: Panel de control → Firewall → Permitir una aplicación →
  busca Node.js y marca "Redes privadas".
- Comprueba que el teléfono está en el mismo WiFi, no en datos móviles.
- Mientras la ventana negra esté abierta, la app funciona. **Si la cierras, se
  apaga.** Para volver a encenderla: abrir terminal, `cd Dolares-por-caja`, `npm start`.

### Dos límites de este camino

1. **Solo funciona dentro del local**, mientras la computadora esté encendida.
2. **No se puede instalar como app** en la pantalla de inicio, porque eso exige
   HTTPS. Se usa desde el navegador normal (guárdala en favoritos). Tomar fotos,
   buscar y la cola sin conexión sí funcionan.

Ambos se resuelven con el camino B.

---

## Camino B — Que funcione siempre y desde cualquier lugar

Aquí la app vive en internet: los teléfonos entran desde donde sea, no depende
de que la computadora del local esté encendida, y sí se instala como app.

### Opción rápida: Railway (sin terminal, ~5 USD/mes)

1. Entra a <https://railway.app> y crea la cuenta con tu GitHub.
2. **New Project → Deploy from GitHub repo →** elige `Dolares-por-caja`.
3. En **Settings → Branch**, selecciona `claude/dollars-received-database-gxgmwh`.
4. En **Variables**, añade:
   - `ANTHROPIC_API_KEY` = tu clave
   - `PIN_ADMIN` = el PIN que quieras
   - `COOKIE_SEGURA` = `1`
5. **Importante:** en **Settings → Volumes**, añade un volumen montado en `/datos`.
   Sin esto se pierden la base de datos y las fotos en cada actualización.
6. En **Settings → Networking → Generate Domain**. Esa dirección `https://...` es
   la que abren los teléfonos.

Render funciona casi igual (New → Web Service → Docker, y un Disk en `/datos`).

### Opción sólida: un VPS propio (~5 USD/mes)

Un servidor en Hetzner, DigitalOcean o Contabo, con Docker. Es lo que yo
recomiendo si esto se va a volver parte del día a día: los datos son tuyos y no
dependes de la política de nadie. Los comandos están en el README.

### Instalar como app en el teléfono

Con la dirección `https://` ya funcionando, abre esa página en el teléfono:

- **Android (Chrome):** menú ⋮ → *Instalar aplicación*.
- **iPhone (Safari):** botón compartir → *Añadir a pantalla de inicio*.

Queda con su icono, se abre a pantalla completa y arranca al instante.

---

## Probarla sin gastar saldo

Para enseñarle la app al personal sin consumir la API, pon esto en el `.env`:

```
SIMULAR_LECTURA=1
```

La app inventa los seriales en vez de mandar las fotos a Claude. Cuando quieras
usarla de verdad, cámbialo a `0`.
