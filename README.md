# Dólares por caja

Sustituye el grupo de WhatsApp donde se pasan las fotos de los dólares recibidos.
La cajera fotografía el billete, la app **lee el número de serie con Claude** y lo
guarda. Después, buscando ese serial, la app dice **de qué cajera era y qué día entró**.

Funciona en teléfono y en computadora: es una página web que se instala como app
(PWA). Corre sobre **Vercel + Supabase**, el mismo stack de la app de delivery.

---

## Qué hace

| | |
|---|---|
| **Registrar** | Se elige la cajera y se sube la foto: tomándola con la cámara, eligiendo varias de la galería, o arrastrándolas desde la computadora. Claude lee cada billete (pueden ir varios en una misma foto) y extrae serial, denominación y año de serie. |
| **Buscar** | Se escribe el serial completo o un pedazo (los últimos 4 dígitos, por ejemplo) y aparece la cajera, la fecha, la foto original y la nota. |
| **Historial** | Todas las fotos subidas, con quién las subió y cuánto sumaban. Al tocar una se despliega ahí mismo con sus billetes, editables uno a uno. |
| **Reportes** | Total por cajera, por día y por denominación. Descarga a Excel (CSV). Muestra el gasto real de la API. |
| **Seriales repetidos** | Si un mismo serial aparece dos veces, la app lo señala. O el billete volvió a entrar, o hay una copia: vale la pena mirarlo. |
| **Diagnóstico** | Una página (`/diagnostico.html`) que comprueba base de datos, almacén de fotos y clave de Claude, y dice qué arreglar y dónde cuando algo falla. |
| **Sin señal** | Si no hay internet, la foto queda guardada en el teléfono y se envía sola cuando vuelve la conexión. |
| **Corregir a mano** | Con el lápiz ✏️ se abre un formulario para cambiar serial, denominación, cajera, serie y nota de cualquier billete ya registrado, o para eliminarlo. Lo corregido queda marcado como verificado. Se llega desde Registrar, desde Buscar y desde Historial. |

---

## Puesta en marcha

**→ Los pasos completos están en [EMPEZAR.md](EMPEZAR.md)**: crear el proyecto de
Supabase, el bucket de fotos, las claves y el despliegue en Vercel.

Resumen para quien ya conoce el stack:

1. **Supabase:** proyecto nuevo + bucket privado `billetes`. Las tablas las crea
   la app sola en el primer arranque (o pega [`esquema.sql`](esquema.sql)).
2. **Vercel:** importa el repositorio, preset *Other*, y añade cinco variables:
   `DATABASE_URL` (pooler en modo **transaction**, puerto 6543),
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `PIN_ADMIN`.
3. Entra con `admin`, cambia el PIN, añade las cajeras y los usuarios.

En local:

```bash
npm install
cp .env.example .env   # rellena los valores
npm start
```

Con `SIMULAR_LECTURA=1` la app inventa los seriales sin llamar a la API: sirve
para enseñársela al personal sin gastar saldo.

```bash
DATABASE_URL_PRUEBA="postgresql://..." npm run prueba
```

La prueba crea su propio esquema temporal y lo borra al terminar, así que se
puede correr contra la misma base sin tocar los datos reales.

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

A esto se le suma la infraestructura: **Vercel Hobby y Supabase Free salen $0**
hasta 1 GB de fotos (unas 3.000, poco más de un mes a 100 diarias). Después,
Supabase Pro son $25/mes por 100 GB.

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
api/index.js         Punto de entrada en Vercel (todo /api/* pasa por aquí)
vercel.json          Rewrites y límite de 60 s por función
src/
  app.js             La aplicación Express: sesiones, rutas y errores
  server.js          Arranque para desarrollo local (en Vercel no se usa)
  db.js              Postgres: pool, transacciones y creación del esquema
  almacen.js         Fotos en Supabase Storage y enlaces firmados
  claude.js          Lectura de los billetes (visión + salida estructurada)
  auth.js            PIN con scrypt y sesiones en cookie
  rutas/
    capturas.js      Subida de fotos, procesado y reintento
    billetes.js      Búsqueda, corrección manual y seriales repetidos
    admin.js         Cajeras y usuarios
    reportes.js      Resúmenes y exportación a CSV
public/              La app (HTML + CSS + JavaScript, sin frameworks)
esquema.sql          Las tablas, por si prefieres crearlas a mano
pruebas/humo.js      Prueba de punta a punta contra un Postgres real
```

**Base de datos:** Postgres en Supabase. Los seriales llevan un índice trigram,
así que buscar un pedazo (`LIKE '%1234%'`) no recorre la tabla entera.

**Fotos:** bucket privado en Supabase Storage. La app entrega enlaces firmados
que caducan a la hora; sin sesión no se ve ninguna imagen.

**Las miniaturas las genera el teléfono**, no el servidor. Por eso la app no
necesita procesar imágenes en el backend: las listas cargan con muy pocos datos
y la función serverless se mantiene ligera.

**Modelo:** `claude-opus-5` con salida estructurada (JSON validado con Zod), así
la respuesta siempre trae los mismos campos y nunca hay que interpretar texto libre.

**Copia de seguridad:** Supabase hace copias automáticas del Postgres. Las fotos
del bucket conviene bajarlas aparte de vez en cuando.

> Si algún día quieres esto sin depender de servicios externos, la versión
> anterior —SQLite en un archivo, fotos en disco, todo en un solo servidor— está
> en el historial, en el commit `c2e8602`.

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
