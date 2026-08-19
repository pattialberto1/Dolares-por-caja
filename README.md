# Dólares por caja

Sustituye el grupo de WhatsApp donde se pasan las fotos de los dólares recibidos.
La cajera fotografía el billete, la app **lee el número de serie con Claude** y lo
guarda. Después, buscando ese serial, la app dice **de qué cajera era y qué día entró**.

Funciona en teléfono y en computadora: es una página web que se instala como app
(PWA). Un solo servidor, una sola base de datos, todos ven lo mismo.

---

## Qué hace

| | |
|---|---|
| **Registrar** | Se elige la cajera, se toma la foto, se sube. Claude lee cada billete de la foto (pueden ir varios juntos) y extrae serial, denominación y año de serie. |
| **Buscar** | Se escribe el serial completo o un pedazo (los últimos 4 dígitos, por ejemplo) y aparece la cajera, la fecha, la foto original y la nota. |
| **Historial** | Todas las fotos subidas, con quién las subió y cuánto sumaban. |
| **Reportes** | Total por cajera, por día y por denominación. Descarga a Excel (CSV). Muestra el gasto real de la API. |
| **Seriales repetidos** | Si un mismo serial aparece dos veces, la app lo señala. O el billete volvió a entrar, o hay una copia: vale la pena mirarlo. |
| **Sin señal** | Si no hay internet, la foto queda guardada en el teléfono y se envía sola cuando vuelve la conexión. |
| **Corregir a mano** | Si Claude leyó mal un dígito, se corrige con el lápiz ✏️ y queda marcado como verificado. |

---

## Puesta en marcha

### 1. Conseguir la clave de la API

En <https://console.anthropic.com> → **API Keys** → crear una clave. Empieza por `sk-ant-`.

### 2. Instalar

```bash
git clone <este-repositorio>
cd Dolares-por-caja
npm install
cp .env.example .env
```

Abre `.env` y pega tu clave en `ANTHROPIC_API_KEY`. Cambia también `PIN_ADMIN`.

### 3. Arrancar

```bash
npm start
```

Abre <http://localhost:3000>, entra con usuario `admin` y el PIN que pusiste.

**Lo primero:** ve a **Ajustes** → añade las cajeras y crea un usuario para cada
persona que vaya a registrar fotos. Cambia el PIN de `admin`.

### Probar sin gastar

Poniendo `SIMULAR_LECTURA=1` en el `.env`, la app inventa los seriales en vez de
llamar a la API. Sirve para enseñarle la app al personal sin consumir saldo.

```bash
npm run prueba    # prueba automática de punta a punta (usa el modo simulado)
```

---

## Ponerla en línea (para que se use desde los teléfonos)

Tres opciones, de menos a más:

**a) Servidor propio en el local.** Deja la app corriendo en la computadora del
local y los teléfonos entran por la red WiFi a `http://<ip-de-la-pc>:3000`.
Gratis, pero solo funciona dentro del local.

**b) Un VPS pequeño** (DigitalOcean, Hetzner, Contabo — entre 4 y 6 USD al mes).
Es la opción recomendada: funciona desde cualquier lugar y los datos son tuyos.

```bash
# en el VPS, con Docker instalado
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up -d
```

Después pon un dominio con HTTPS delante (Caddy o Nginx) y cambia `COOKIE_SEGURA=1`.
Con Caddy son dos líneas:

```
dolares.tudominio.com {
    reverse_proxy localhost:3000
}
```

**c) Plataformas tipo Railway, Render o Fly.io.** Suben el Dockerfile directo.
Ojo: hay que montar un disco persistente en `/datos`, si no se pierden la base
de datos y las fotos en cada despliegue.

### Instalarla como app en el teléfono

Abre la dirección en Chrome (Android) o Safari (iPhone) → menú →
**"Añadir a pantalla de inicio"**. Queda con su icono, como cualquier otra app.

---

## Cuánto cuesta la API

Cada foto son unos 3.200 tokens de entrada (la imagen) y unos 300 de salida.
Cálculo aproximado por foto y al mes con **100 fotos diarias**:

| Modelo (`MODELO_CLAUDE`) | Por foto | 100 fotos/día | Cuándo usarlo |
|---|---|---|---|
| `claude-opus-5` *(por defecto)* | ~$0,025 | ~$75/mes | Fotos de calidad variable, billetes gastados. Es el que menos se equivoca leyendo. |
| `claude-sonnet-5` | ~$0,016 | ~$48/mes | Equilibrio. |
| `claude-haiku-4-5` | ~$0,005 | ~$15/mes | Si las fotos siempre salen nítidas y de cerca. |

Son estimaciones. **El gasto real medido lo muestra la pestaña Reportes**, sumado
del consumo que devuelve la propia API en cada foto.

Dos formas de gastar menos sin cambiar de modelo:
- Bajar `MAX_LADO_PX` de 1800 a 1400: cuesta como un 40 % menos, pero lee peor los
  billetes borrosos.
- Fotografiar **varios billetes en una sola foto**: se paga una imagen y se
  registran todos.

---

## Cómo tomar la foto

Esto decide si el sistema sirve o no:

1. Billete **plano**, sobre una superficie lisa, sin doblar.
2. El **número de serie completo** dentro del cuadro (está dos veces en el
   anverso: arriba a la derecha y abajo a la izquierda).
3. **Sin reflejos** del flash sobre el serial. Mejor con luz del ambiente.
4. Varios billetes juntos: que se vea el serial de cada uno, sin taparse.

Cuando Claude no está seguro de lo que leyó, marca el billete como
**"revisar"** y pone `?` en los caracteres que no distinguió. Esos se corrigen a
mano en el momento con el lápiz ✏️.

---

## Cómo está hecho

```
src/
  server.js          Servidor Express, sesiones y arranque
  db.js              SQLite: tablas de cajeras, usuarios, capturas y billetes
  claude.js          Lectura de los billetes con Claude (visión + salida estructurada)
  auth.js            PIN con scrypt y sesiones en cookie
  rutas/
    capturas.js      Subida de fotos, procesado y reintento
    billetes.js      Búsqueda, corrección manual y seriales repetidos
    admin.js         Cajeras y usuarios
    reportes.js      Resúmenes y exportación a CSV
publico/             La app (HTML + CSS + JavaScript, sin frameworks)
pruebas/humo.js      Prueba de punta a punta
```

**Base de datos:** SQLite, un solo archivo en `datos/dolares.db`. Aguanta de sobra
el volumen de un local (millones de billetes). Las fotos van en `datos/fotos/`.

**Modelo:** `claude-opus-5` con salida estructurada (JSON validado con Zod), así
la respuesta siempre trae los mismos campos y nunca hay que interpretar texto libre.

**Copia de seguridad:** con copiar la carpeta `datos/` completa es suficiente.

```bash
tar czf respaldo-$(date +%F).tar.gz datos/
```

---

## Detalles importantes

- **La misma foto no se registra dos veces.** Se identifica por su contenido, así
  que si alguien la sube de nuevo la app avisa en vez de duplicar.
- **Las fotos solo se ven con sesión iniciada**, no quedan expuestas en internet.
- **Los PIN se guardan cifrados** (scrypt con sal), nunca en texto plano.
- **La app no dice si un billete es falso.** Claude transcribe lo que ve, nada más.
  La única señal automática de alerta es el serial repetido, y es una señal para
  ir a mirar el billete, no un veredicto.
- **Nada se borra solo.** Los billetes se pueden corregir y eliminar a mano, y
  todo queda con su foto original asociada.
