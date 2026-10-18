import { Request, Response } from 'express';
import { collectorService } from '../collector/collector.service';
import { envAnalysisOptions } from '../config';
import { AnalysisInputError, AnalysisOptions, ArbitrageService, DEFAULT_OPTIONS, HistoryEntry } from '../services/arbitrage.service';


const arbitrageService = new ArbitrageService();

// Csak az ismert, nemnegatív számként megadott beállításokat vesszük át
const parseOptions = (raw: unknown): Partial<AnalysisOptions> => {
  if (!raw || typeof raw !== 'object') return {};
  const allowed = [...Object.keys(DEFAULT_OPTIONS), 'keyPriceMetal'];
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.includes(key)) continue;
    const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0) {
      throw new AnalysisInputError(`Az options.${key} értéke nemnegatív szám kell legyen.`);
    }
    result[key] = parsed;
  }
  return result;
};

const handleError = (res: Response, error: unknown) => {
  if (error instanceof AnalysisInputError) {
    return res.status(400).json({ error: error.message });
  }
  console.error('Elemzési hiba:', error);
  return res.status(500).json({ error: 'Belső szerverhiba történt' });
};

export const analyzeArbitrage = async (req: Request, res: Response) => {
  try {
    // Elfogadott formák: history tömb, egyetlen bejegyzés, vagy { history, options }
    const body = req.body;
    let entries: HistoryEntry[];
    let rawOptions: unknown;
    if (Array.isArray(body)) {
      entries = body;
    } else if (body && Array.isArray(body.history)) {
      entries = body.history;
      rawOptions = body.options;
    } else if (body && body.buy) {
      entries = [body];
    } else {
      return res.status(400).json({ error: 'Hiányzó tárgy adatok!' });
    }

    // Kulcsár: a kérésben megadott fix érték > a gyűjtő által letöltött kulcsár-history > KEY_PRICE_METAL
    const requestOptions = parseOptions(rawOptions);
    const options: Partial<AnalysisOptions> = { ...envAnalysisOptions(), ...requestOptions };
    const keyPrices = await collectorService.getKeyPriceHistory();
    if (keyPrices.length > 0 && requestOptions.keyPriceMetal === undefined) delete options.keyPriceMetal;

    const result = arbitrageService.analyzeItemHistory(entries, options, keyPrices);
    return res.status(200).json(result);
  } catch (error) {
    return handleError(res, error);
  }
};

// GET /api/arbitrage/tracked – a követett SKU-k legutóbbi elemzése (legjobb ajánlatok elöl)
export const getTrackedAnalysis = async (req: Request, res: Response) => {
  try {
    const analysis = (await collectorService.getAnalysis()) as { results: { recommendation?: string }[] } | null;
    if (!analysis) {
      return res.status(404).json({ error: 'Még nincs elemzés: a gyűjtő még nem futott le.' });
    }
    const filter = typeof req.query.recommendation === 'string' ? req.query.recommendation.toUpperCase() : undefined;
    return res.json(filter ? { ...analysis, results: analysis.results.filter((r) => r.recommendation === filter) } : analysis);
  } catch (error) {
    return handleError(res, error);
  }
};

// GET /api/arbitrage/tracked/:sku – egy SKU friss elemzése a mentett history-ból (query paraméterben beállítások)
export const getTrackedSku = async (req: Request, res: Response) => {
  try {
    const sku = String(req.params.sku);
    const result = await collectorService.analyze(sku, parseOptions(req.query));
    if (!result) {
      return res.status(404).json({ error: `Nincs mentett history ehhez az SKU-hoz: ${sku}` });
    }
    return res.json(result);
  } catch (error) {
    return handleError(res, error);
  }
};
