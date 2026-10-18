import { Request, Response } from 'express';
import { ArbitrageService } from '../services/arbitrage.service';


const arbitrageService = new ArbitrageService();

export const analyzeArbitrage = async (req: Request, res: Response) => {
  try {
    const itemData = req.body;

    console.log(itemData);
    // Egyszerű validáció
    if (!itemData || !itemData.buy) {
      return res.status(400).json({ error: 'Hiányzó tárgy adatok!' });
    }

    // Átadjuk a nehéz munkát a Service-nek
    const result = arbitrageService.analyzeItemHistory(itemData);

    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: 'Belső szerverhiba történt' });
  }
};