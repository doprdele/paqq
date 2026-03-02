<div align="center">
<br>
  <img src="https://raw.githubusercontent.com/Paylicier/Packt/refs/heads/main/frontend/logo.svg" alt="Packt Logo" width="400"/>
  
  # Packt 
  
  A modern package tracking platform that lets you monitor all your shipments in one place
</div>

## Features 

###  **Multi-Carrier Support**
  - DHL
  - La Poste
  - Colissimo
  - Chronopost
  - Mondial Relay
  - Asendia
  - FedEx
  - USPS
  - Add your own !
  
###  **Easy Tracking**
  - Detailed event history
  - Location tracking
  
###  **Modern (and beautiful) UI**
  - Dark/Light mode
  - Responsive design
  - Clean interface
  
###  **Package Sharing**
  - Generate share links
  - Import packages from links
  
###  **Local Storage**
  - Offline access
  - No account needed
  - Data persistence

###  **Progressive Web App support**
  - Easy install
  - Native-like experience

## Setup 

### Runtime Modes

Packt backend now supports two runtime adapters:
- Cloudflare Worker adapter (`backend/src/index.ts`)
- Node adapter (`backend/src/node.ts`)

Both adapters use the same core request handler (`backend/src/app.ts`).

### Backend (Cloudflare Worker)

1. Edit vars in `.dev.vars` (or the production version if using on production)
2. Install and run the backend
```bash
cd backend
bun install
bunx wrangler dev
```

### Backend (Node Runtime)

```bash
cd backend
npm install
npm run start:node
```

### USPS Scraper Service (Playwright/CDP)

USPS tracking is fetched through a dedicated scraper service (`usps-scraper`) using Playwright + stealth hardening.

```bash
cd usps-scraper
npm install
npm run start
```

Backend environment variables for USPS:
- `USPS_SCRAPER_URL` (default `http://127.0.0.1:8790`)
- `USPS_SCRAPER_TOKEN` (optional shared secret, sent as `x-usps-scraper-token`)
- `USPS_SCRAPER_TIMEOUT_MS` (optional request timeout, default `60000`)
- `USPS_CDP_WS_ENDPOINT` (optional CDP endpoint used by scraper via `connectOverCDP`)

### Frontend
By default the frontend uses `https://packt.notri1.workers.dev`.

For self-hosting, set `window.__PACKT_CONFIG__.API_BASE_URL` in `frontend/runtime-config.js`.

### Docker Compose (Self-Hosted)

This repository includes a self-host stack:
- `frontend` (nginx)
- `backend` (Node adapter)
- `usps-scraper` (Playwright + stealth)

Run:
```bash
docker compose up -d --build
```

Endpoints:
- Frontend: `http://localhost:8080`
- Backend API: `http://localhost:8787`
- USPS scraper: `http://localhost:8790`

Optional environment overrides:
- `PACKT_API_BASE_URL` (frontend runtime config; default empty in compose, so nginx proxies `/api` to backend)
- `USPS_SCRAPER_TOKEN`
- `USPS_SCRAPER_TIMEOUT_MS`

## API Documentation 

The backend API provides endpoints for:
- `/api/list` - Get list of supported carriers

Response:
```json
[
  {
    "name": "string",
    "icon": "string",
    "requiredFields": ["string"]
  }
]
```
- `/api/get` - Get tracking information

Response:
```json
{
  "trackingNumber": "string",
  "trackingUrl": "string",
  "carrier": "string",
  "status": {
    "code": "string",
    "description": "string",
    "timestamp": "string",
    "location": "string"
  },
  "estimatedDelivery": "string",
  "events": [
    {
      "code": "string",
      "description": "string",
      "timestamp": "string",
      "location": "string"
    }
  ]
}
```


## Contributing 

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License 

This project is available under **Mozilla Public License 2.0 (MPL-2.0)**

Please read the license carefully before using this software. If you have any questions about licensing, please open an issue.

---

<div align="center">
  Built with ❤️ and 🌊 by Paylicier
</div>
