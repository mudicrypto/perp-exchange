"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "@/core/domain";
import type { CandleState } from "../hooks/use-market-data";

const UP = "#2ebd85";
const DOWN = "#f0616d";

function toBar(candle: Candle) {
  return {
    time: Math.floor(candle.openTime / 1000) as UTCTimestamp,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };
}

function toVolume(candle: Candle) {
  return {
    time: Math.floor(candle.openTime / 1000) as UTCTimestamp,
    value: candle.volume,
    color: candle.close >= candle.open ? `${UP}55` : `${DOWN}55`,
  };
}

/**
 * Candlestick + volume chart (TradingView lightweight-charts). Full history
 * is pushed with setData when `historyVersion` changes; live candles go
 * through `update`, which is cheap and keeps the user's zoom.
 */
export function PriceChart({ state, priceDecimals }: { state: CandleState; priceDecimals: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const { candles, historyVersion, latest } = state;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9aa3b2",
        fontSize: 11,
        attributionLogo: true,
      },
      grid: { vertLines: { color: "#262a35" }, horzLines: { color: "#262a35" } },
      rightPriceScale: { borderColor: "#2c303b" },
      timeScale: { borderColor: "#2c303b", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      // Pin the locale: lightweight-charts defaults to navigator.language, and
      // malformed browser locales (e.g. "en-US@posix") make Intl throw.
      localization: { locale: "en-US" },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      borderVisible: false,
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    chartRef.current = chart;
    candleRef.current = candleSeries;
    volumeRef.current = volumeSeries;
    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
    };
  }, []);

  useEffect(() => {
    candleRef.current?.applyOptions({
      priceFormat: { type: "price", precision: priceDecimals, minMove: 10 ** -priceDecimals },
    });
  }, [priceDecimals]);

  useEffect(() => {
    if (historyVersion === 0) return;
    candleRef.current?.setData(candles.map(toBar));
    volumeRef.current?.setData(candles.map(toVolume));
    chartRef.current?.timeScale().fitContent();
    // `candles` is a live view; only re-push on new history versions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyVersion]);

  useEffect(() => {
    if (!latest || historyVersion === 0) return;
    try {
      candleRef.current?.update(toBar(latest));
      volumeRef.current?.update(toVolume(latest));
    } catch {
      // lightweight-charts throws on out-of-order updates; CandleSeries already filters them.
    }
  }, [latest, historyVersion]);

  return <div ref={containerRef} className="absolute inset-0" data-testid="price-chart" />;
}
