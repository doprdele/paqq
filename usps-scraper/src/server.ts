import { scrapeUspsTracking } from "./scrape.js";
import { scrapeUniuniTracking } from "./uniuni.js";
import { scrapeUpsTracking } from "./ups.js";
import { createScraperServer } from "./server-app.js";

const port = Number(process.env.PORT ?? "8790");
const server = createScraperServer({
  usps: scrapeUspsTracking,
  uniuni: scrapeUniuniTracking,
  ups: scrapeUpsTracking,
});

server.listen(port, () => {
  process.stdout.write(`Paqq scraper service listening on port ${port}\n`);
});
