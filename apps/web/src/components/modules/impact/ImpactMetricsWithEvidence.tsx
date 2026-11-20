/**
 * Impact Metrics with Evidence Links Component
 * 
 * Issue #1: Link claimed impact metrics to their evidence and distinguish 
 * verified measurements from campaign-reported estimates.
 * 
 * This component displays campaign impact metrics with:
 *   - Visual distinction between verified vs. reported measurements
 *   - Links to evidence (carbon accounting methodology, verification audit logs)
 *   - Uncertainty bands and source citations
 *   - Last update timestamps
 */

"use client";

import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, CheckCircle, Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getMaterialTermTranslation } from "@/lib/material-terms-glossary";
import { CO2_ACCOUNTING_BASIS } from "@/lib/carbon-accounting-constants";

export interface ImpactMetricData {
  /** The metric name (e.g., "CO2 Offset", "Trees Planted") */
  label: string;
  
  /** The measured or estimated value */
  value: number | string;
  
  /** Unit of measurement */
  unit: string;
  
  /** Is this a verified measurement or campaign-reported estimate? */
  verificationStatus: "verified" | "reported" | "forecasted";
  
  /** Link to evidence (audit contract, verification records, etc.) */
  evidenceLink?: string;
  
  /** When was this measurement made or last updated? */
  lastUpdated: string;
  
  /** Uncertainty band (if applicable) */
  uncertaintyBand?: string;
  
  /** Source of this metric */
  source: string;
  
  /** Additional context or explanation */
  description?: string;
  
  /** Related methodology document */
  methodologyLink?: string;
}

export interface ImpactMetricsWithEvidenceProps {
  /** Array of impact metrics to display */
  metrics: ImpactMetricData[];
  
  /** Campaign name (for context) */
  campaignName?: string;
  
  /** Current user's locale for translations */
  locale?: string;
  
  /** Custom CSS class */
  className?: string;
}

/**
 * Get status badge color based on verification status
 */
function getStatusColor(status: "verified" | "reported" | "forecasted"): string {
  switch (status) {
    case "verified":
      return "bg-green-100 text-green-800 border-green-300";
    case "reported":
      return "bg-yellow-100 text-yellow-800 border-yellow-300";
    case "forecasted":
      return "bg-blue-100 text-blue-800 border-blue-300";
  }
}

/**
 * Get status icon based on verification status
 */
function getStatusIcon(status: "verified" | "reported" | "forecasted"): React.ReactNode {
  switch (status) {
    case "verified":
      return <CheckCircle className="w-4 h-4" />;
    case "reported":
      return <AlertCircle className="w-4 h-4" />;
    case "forecasted":
      return <Info className="w-4 h-4" />;
  }
}

/**
 * Get status label based on verification status
 */
function getStatusLabel(status: "verified" | "reported" | "forecasted", locale?: string): string {
  switch (status) {
    case "verified":
      return locale === "es" ? "Verificado" : locale === "fr" ? "Vérifié" : "Verified";
    case "reported":
      return locale === "es" ? "Reportado" : locale === "fr" ? "Signalé" : "Reported";
    case "forecasted":
      return locale === "es" ? "Proyectado" : locale === "fr" ? "Projection" : "Forecast";
  }
}

/**
 * Single Impact Metric Card
 */
function ImpactMetricCard({
  metric,
  locale = "en",
}: {
  metric: ImpactMetricData;
  locale?: string;
}): React.ReactElement {
  const statusLabel = getStatusLabel(metric.verificationStatus, locale);
  const statusIcon = getStatusIcon(metric.verificationStatus);
  const statusColor = getStatusColor(metric.verificationStatus);
  
  // Get translated term name if applicable
  const translatedLabel = locale && locale !== "en" 
    ? getMaterialTermTranslation(metric.label, locale) || metric.label
    : metric.label;
  
  return (
    <div className="p-4 border rounded-lg bg-white">
      <div className="flex justify-between items-start mb-3">
        <div>
          <h3 className="font-semibold text-lg">{translatedLabel}</h3>
          <p className="text-sm text-gray-600">{metric.description}</p>
        </div>
        <Badge className={`flex items-center gap-1 border ${statusColor}`}>
          {statusIcon}
          {statusLabel}
        </Badge>
      </div>
      
      <div className="mb-4">
        <div className="text-3xl font-bold text-primary">
          {typeof metric.value === "number" 
            ? metric.value.toLocaleString(locale) 
            : metric.value}
        </div>
        <div className="text-sm text-gray-600 mt-1">
          {metric.unit}
          {metric.uncertaintyBand && (
            <span className="ml-2 font-mono">({metric.uncertaintyBand})</span>
          )}
        </div>
      </div>
      
      <div className="space-y-2 text-xs text-gray-600">
        <div>
          <strong>Source:</strong> {metric.source}
        </div>
        <div>
          <strong>Last updated:</strong>{" "}
          {new Date(metric.lastUpdated).toLocaleDateString(locale)}
        </div>
      </div>
      
      <div className="mt-4 flex flex-wrap gap-2">
        {metric.evidenceLink && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={metric.evidenceLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-600 hover:text-blue-800 hover:underline"
                >
                  View Evidence ↗
                </a>
              </TooltipTrigger>
              <TooltipContent>
                <p>View this metric's underlying evidence and audit records</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        
        {metric.methodologyLink && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={metric.methodologyLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-gray-600 hover:text-gray-800 hover:underline"
                >
                  Methodology ↗
                </a>
              </TooltipTrigger>
              <TooltipContent>
                <p>Learn how this metric is calculated and verified</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
    </div>
  );
}

/**
 * Impact Metrics with Evidence Links Component
 * 
 * Main component that displays all impact metrics with evidence links
 */
export function ImpactMetricsWithEvidence({
  metrics,
  campaignName,
  locale = "en",
  className = "",
}: ImpactMetricsWithEvidenceProps): React.ReactElement {
  const verifiedMetrics = metrics.filter(m => m.verificationStatus === "verified");
  const reportedMetrics = metrics.filter(m => m.verificationStatus === "reported");
  const forecastedMetrics = metrics.filter(m => m.verificationStatus === "forecasted");
  
  const disclaimerText = {
    en: "Impact metrics are displayed with their verification status. Verified measurements come from independent audits. Reported estimates are campaign-submitted but not yet verified. Forecasts are projections based on stated assumptions.",
    es: "Las métricas de impacto se muestran con su estado de verificación. Las mediciones verificadas provienen de auditorías independientes. Las estimaciones reportadas son presentadas por la campaña pero aún no verificadas. Las proyecciones se basan en suposiciones establecidas.",
    fr: "Les métriques d'impact sont affichées avec leur statut de vérification. Les mesures vérifiées proviennent d'audits indépendants. Les estimations signalées sont soumises par la campagne mais pas encore vérifiées. Les projections sont basées sur des hypothèses explicites.",
  };
  
  const disclaimer = disclaimerText[locale as keyof typeof disclaimerText] || disclaimerText.en;
  
  return (
    <div className={`space-y-6 ${className}`}>
      {campaignName && (
        <div>
          <h2 className="text-2xl font-bold">{campaignName} Impact</h2>
          <p className="text-gray-600 text-sm mt-1">Verified & Reported Metrics</p>
        </div>
      )}
      
      {/* Disclaimer */}
      <Card className="bg-blue-50 border-blue-200">
        <CardContent className="pt-6">
          <div className="flex gap-3">
            <Info className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-blue-900">{disclaimer}</p>
          </div>
        </CardContent>
      </Card>
      
      {/* Verified Metrics */}
      {verifiedMetrics.length > 0 && (
        <section>
          <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <CheckCircle className="w-5 h-5 text-green-600" />
            {locale === "es" ? "Mediciones Verificadas" : locale === "fr" ? "Mesures Vérifiées" : "Verified Measurements"}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {verifiedMetrics.map((metric, idx) => (
              <ImpactMetricCard key={idx} metric={metric} locale={locale} />
            ))}
          </div>
        </section>
      )}
      
      {/* Reported Metrics */}
      {reportedMetrics.length > 0 && (
        <section>
          <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-yellow-600" />
            {locale === "es" ? "Estimaciones Reportadas" : locale === "fr" ? "Estimations Signalées" : "Campaign-Reported Estimates"}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {reportedMetrics.map((metric, idx) => (
              <ImpactMetricCard key={idx} metric={metric} locale={locale} />
            ))}
          </div>
        </section>
      )}
      
      {/* Forecasted Metrics */}
      {forecastedMetrics.length > 0 && (
        <section>
          <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <Info className="w-5 h-5 text-blue-600" />
            {locale === "es" ? "Proyecciones" : locale === "fr" ? "Projections" : "Forecasts"}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {forecastedMetrics.map((metric, idx) => (
              <ImpactMetricCard key={idx} metric={metric} locale={locale} />
            ))}
          </div>
        </section>
      )}
      
      {/* Carbon Accounting Methodology Link */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Carbon Accounting Methodology</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 mb-3">
            All CO2 calculations use IPCC Tier 1 methodology with {CO2_ACCOUNTING_BASIS.uncertaintyBand} uncertainty.
          </p>
          <a
            href={CO2_ACCOUNTING_BASIS.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-600 hover:text-blue-800 hover:underline"
          >
            Read Full Methodology ({CO2_ACCOUNTING_BASIS.reference}) ↗
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
