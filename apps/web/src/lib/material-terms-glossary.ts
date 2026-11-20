/**
 * Material Terms Glossary
 * 
 * Issue #4: Track locale and translation version, identify untranslated material terms
 * 
 * Defines financial and technical terms that must be translated accurately in all
 * supported locales. These terms appear in:
 *   - Campaign descriptions
 *   - Sponsor receipts
 *   - Verification audit logs
 *   - Tax documentation
 *   - Regulatory compliance reports
 * 
 * All translations are reviewed by domain experts before deployment.
 */

export interface MaterialTermTranslation {
  term: string;
  definition: string;
  /** Locale-specific usage notes (e.g., formal vs. informal register) */
  notes?: string;
  /** Translation was reviewed and approved on this date */
  approvedAt?: string;
  /** Translator's name or team */
  approvedBy?: string;
  /** Flag if translation is still in progress */
  incomplete?: boolean;
}

export interface MaterialTermEntry {
  /** English term (authoritative version) */
  englishTerm: string;
  
  /** Full definition in English */
  definition: string;
  
  /** Where this term is used */
  context: "financial" | "technical" | "legal" | "regulatory";
  
  /** Translations by IETF locale code */
  translations: Record<string, MaterialTermTranslation>;
  
  /** Related terms (cross-references) */
  relatedTerms: string[];
  
  /** Source: publication, regulation, or standard */
  source?: string;
  
  /** Minimum locales where this term MUST be translated (ISO 639-1 codes) */
  requiredLocales: string[];
}

// ── Financial & Sponsorship Terms ──────────────────────────────────────────

export const MATERIAL_TERMS: MaterialTermEntry[] = [
  {
    englishTerm: "CO2 offset",
    definition: "Reduction or removal of greenhouse gas emissions, measured in kg CO₂ equivalent (CO₂e) per year. In this platform, refers to CO2 sequestered (removed from atmosphere) by planted trees, not avoided emissions.",
    context: "technical",
    translations: {
      en: { 
        term: "CO2 offset", 
        definition: "Reduction or removal of greenhouse gas emissions, measured in kg CO₂ equivalent (CO₂e) per year...",
        approvedAt: "2024-01-15",
        approvedBy: "Carbon Team",
      },
      es: { 
        term: "Compensación de carbono", 
        definition: "Reducción o eliminación de emisiones de gases de efecto invernadero...",
        notes: "Use 'secuestro de carbono' to emphasize tree-based removal (not just avoidance).",
        approvedAt: "2024-02-20",
        approvedBy: "Equipo Latinoamérica",
      },
      fr: { 
        term: "Compensation carbone", 
        definition: "Réduction ou élimination des émissions de gaz à effet de serre...",
        notes: "French distinguishes 'compensation' (removal) from 'réduction' (avoided). Use 'séquestration du carbone' for tree-based removal.",
        approvedAt: "2024-02-15",
        approvedBy: "Équipe France",
      },
      de: { 
        term: "CO₂-Ausgleich", 
        definition: "Verringerung oder Beseitigung von Treibhausgasemissionen...",
        notes: "German technical term: 'Kohlenstoffbindung' for carbon sequestration by trees.",
        approvedAt: "2024-03-01",
        approvedBy: "Deutsches Team",
      },
      pt: { 
        term: "Compensação de carbono", 
        definition: "Redução ou remoção de emissões de gases de efeito estufa...",
        notes: "In Brazilian context, distinguish 'sequestro de carbono' (active removal) from 'redução' (avoided).",
        approvedAt: "2024-03-10",
        approvedBy: "Equipe Brasil",
      },
      ja: { 
        term: "カーボンオフセット", 
        definition: "温室効果ガス排出量の削減または除去...",
        notes: "If trees are primary method, consider 'カーボンシンク' (carbon sink).",
        approvedAt: "2024-03-15",
        approvedBy: "日本チーム",
        incomplete: true,
      },
    },
    relatedTerms: ["carbon sequestration", "GHG emissions", "carbon credit", "tree planting"],
    source: "IPCC AR6 WG3, Chapter 5",
    requiredLocales: ["en", "es", "fr", "de"],
  },

  {
    englishTerm: "Verification evidence",
    definition: "Photographic, GPS, satellite, or auditor documentation proving that trees were planted at claimed locations on claimed dates. Evidence is immutably recorded in the campaign-verification-audit contract.",
    context: "legal",
    translations: {
      en: { 
        term: "Verification evidence", 
        definition: "Photographic, GPS, satellite, or auditor documentation...",
        approvedAt: "2024-01-20",
        approvedBy: "Audit Team",
      },
      es: { 
        term: "Evidencia de verificación", 
        definition: "Documentación fotográfica, GPS, satelital o de auditor...",
        notes: "Legal term in Spanish. Distinguish from 'prueba de plantación' (planting proof).",
        approvedAt: "2024-02-25",
        approvedBy: "Equipo Legal",
      },
      fr: { 
        term: "Preuve de vérification", 
        definition: "Documentation photographique, GPS, satellite ou d'auditeur...",
        notes: "French legal: 'preuve' (proof/evidence) is legally binding term.",
        approvedAt: "2024-02-20",
        approvedBy: "Équipe Légale",
      },
      de: { 
        term: "Verifikationsbeweis", 
        definition: "Fotografische, GPS-, Satelliten- oder Auditor-Dokumentation...",
        approvedAt: "2024-03-05",
        approvedBy: "Deutsches Audit-Team",
      },
      pt: { 
        term: "Evidência de verificação", 
        definition: "Documentação fotográfica, GPS, satélite ou de auditor...",
        approvedAt: "2024-03-15",
        approvedBy: "Equipe Auditoria Brasil",
      },
    },
    relatedTerms: ["audit trail", "tree batch", "photo submission", "campaign-verification-audit contract"],
    source: "Campaign Verification Audit Contract (Soroban)",
    requiredLocales: ["en", "es", "fr"],
  },

  {
    englishTerm: "Campaign target",
    definition: "The funding goal (in stroops) that a campaign aims to reach. Campaigns can change their target before reaching 'Active' status. All historical target values and change timestamps are preserved in the campaign record.",
    context: "financial",
    translations: {
      en: { 
        term: "Campaign target", 
        definition: "The funding goal (in stroops) that a campaign aims to reach...",
        approvedAt: "2024-01-25",
        approvedBy: "Financial Team",
      },
      es: { 
        term: "Objetivo de campaña", 
        definition: "La meta de financiación (en stroops) que busca alcanzar una campaña...",
        notes: "Distinguish from 'meta de árboles' (tree planting target).",
        approvedAt: "2024-02-28",
        approvedBy: "Equipo Finanzas",
      },
      fr: { 
        term: "Objectif de la campagne", 
        definition: "L'objectif de financement (en stroops) qu'une campagne vise à atteindre...",
        notes: "French uses 'objectif' (objective) or 'cible' (target). Choose 'objectif' for official communications.",
        approvedAt: "2024-02-22",
        approvedBy: "Équipe Finances",
      },
    },
    relatedTerms: ["milestone", "funding goal", "target change", "sponsor commitment"],
    source: "Campaign Funding Contract (Soroban), Issue #3",
    requiredLocales: ["en", "es"],
  },

  {
    englishTerm: "Sponsor exposure",
    definition: "Projected impact metrics showing what a sponsor's funding could achieve under different scenarios (e.g., 'if planting continues at current pace'). All projections are labeled as forecasts based on stated assumptions, not settled balances.",
    context: "financial",
    translations: {
      en: { 
        term: "Sponsor exposure", 
        definition: "Projected impact metrics showing what a sponsor's funding could achieve under different scenarios...",
        notes: "UI must display disclaimer: '⚠️ This is a forecast based on current planting assumptions.'",
        approvedAt: "2024-01-30",
        approvedBy: "Analytics Team",
      },
      es: { 
        term: "Exposición del patrocinador", 
        definition: "Métricas de impacto proyectadas mostrando lo que la financiación del patrocinador podría lograr...",
        notes: "Include disclaimer in Spanish: '⚠️ Esta es una proyección basada en suposiciones actuales de plantación.'",
        approvedAt: "2024-03-05",
        approvedBy: "Equipo Analítica",
      },
      fr: { 
        term: "Exposition du parrain", 
        definition: "Métriques d'impact projetées montrant ce que le financement d'un parrain pourrait réaliser...",
        notes: "Disclaimer in French: '⚠️ Ceci est une projection basée sur les hypothèses actuelles de plantation.'",
        approvedAt: "2024-03-08",
        approvedBy: "Équipe Analytique",
      },
    },
    relatedTerms: ["forecast", "scenario", "assumption", "impact projection"],
    source: "Issue #2, Scenario-Based Sponsor Exposure",
    requiredLocales: ["en"],
  },

  {
    englishTerm: "Scenario-based forecast",
    definition: "Conditional projection of impact metrics under explicitly stated assumptions (e.g., 'If planting continues at 2024 rate: 5,000 trees = 100,000 kg CO2/year by 2030'). Forecasts are never represented as settled or guaranteed balances.",
    context: "financial",
    translations: {
      en: { 
        term: "Scenario-based forecast", 
        definition: "Conditional projection of impact metrics under explicitly stated assumptions...",
        notes: "Always display: assumption list, uncertainty band (±%), last updated date.",
        approvedAt: "2024-02-01",
        approvedBy: "Analytics Team",
      },
      es: { 
        term: "Proyección basada en escenarios", 
        definition: "Proyección condicional de métricas de impacto bajo suposiciones explícitamente establecidas...",
        approvedAt: "2024-03-12",
        approvedBy: "Equipo Analítica",
      },
      fr: { 
        term: "Projection basée sur des scénarios", 
        definition: "Projection conditionnelle des métriques d'impact selon des hypothèses explicitement énoncées...",
        approvedAt: "2024-03-14",
        approvedBy: "Équipe Analytique",
      },
    },
    relatedTerms: ["assumption", "forecast", "projection", "impact metric"],
    source: "Issue #2",
    requiredLocales: ["en"],
  },

  {
    englishTerm: "Campaign milestone",
    definition: "A defined planting or funding target within a campaign (e.g., '10,000 trees verified' or '50% of funding goal reached'). Milestone definitions can be updated, and such changes are tracked with timestamps and reasons.",
    context: "financial",
    translations: {
      en: { 
        term: "Campaign milestone", 
        definition: "A defined planting or funding target within a campaign...",
        approvedAt: "2024-01-28",
        approvedBy: "Product Team",
      },
      es: { 
        term: "Hito de la campaña", 
        definition: "Un objetivo de plantación o financiación definido dentro de una campaña...",
        notes: "In Spanish legal context: 'hito' (milestone) is the standard term.",
        approvedAt: "2024-03-02",
        approvedBy: "Equipo Producto",
      },
      fr: { 
        term: "Jalon de la campagne", 
        definition: "Un objectif de plantation ou de financement défini au sein d'une campagne...",
        approvedAt: "2024-03-16",
        approvedBy: "Équipe Produit",
      },
    },
    relatedTerms: ["campaign target", "payout", "verified completion"],
    source: "Campaign Funding Contract",
    requiredLocales: ["en", "es"],
  },

  {
    englishTerm: "Verified measurement",
    definition: "Impact metric (trees planted, CO2 offset) that has been independently audited and recorded in the campaign-verification-audit contract. Verified measurements are distinguished from campaign-reported estimates.",
    context: "technical",
    translations: {
      en: { 
        term: "Verified measurement", 
        definition: "Impact metric (trees planted, CO2 offset) that has been independently audited...",
        notes: "Always distinguish from 'campaign-reported' or 'self-reported' estimates in UI.",
        approvedAt: "2024-02-05",
        approvedBy: "Verification Team",
      },
      es: { 
        term: "Medición verificada", 
        definition: "Métrica de impacto (árboles plantados, compensación de CO2) que ha sido auditada de forma independiente...",
        approvedAt: "2024-03-18",
        approvedBy: "Equipo Verificación",
      },
      fr: { 
        term: "Mesure vérifiée", 
        definition: "Métrique d'impact (arbres plantés, compensation CO2) qui a été auditée de manière indépendante...",
        approvedAt: "2024-03-20",
        approvedBy: "Équipe Vérification",
      },
    },
    relatedTerms: ["verification evidence", "audit trail", "campaign-reported estimate"],
    source: "Campaign Verification Audit Contract, Issue #1",
    requiredLocales: ["en"],
  },

  {
    englishTerm: "Campaign-reported estimate",
    definition: "Impact metric (trees planted, CO2 offset) submitted by the campaign creator but not yet independently verified. Estimates are clearly labeled as such and may differ from verified measurements.",
    context: "technical",
    translations: {
      en: { 
        term: "Campaign-reported estimate", 
        definition: "Impact metric submitted by the campaign creator but not yet independently verified...",
        notes: "UI label: 'Reported by campaign (pending verification)'. Never mix with verified data.",
        approvedAt: "2024-02-08",
        approvedBy: "Verification Team",
      },
      es: { 
        term: "Estimación reportada por la campaña", 
        definition: "Métrica de impacto presentada por el creador de la campaña pero aún no verificada de forma independiente...",
        notes: "Etiqueta UI: 'Reportado por la campaña (pendiente verificación)'.",
        approvedAt: "2024-03-21",
        approvedBy: "Equipo Verificación",
      },
      fr: { 
        term: "Estimation signalée par la campagne", 
        definition: "Métrique d'impact soumise par le créateur de la campagne mais pas encore vérifiée de manière indépendante...",
        notes: "Étiquette UI: 'Signalé par la campagne (en attente de vérification)'.",
        approvedAt: "2024-03-22",
        approvedBy: "Équipe Vérification",
      },
    },
    relatedTerms: ["verified measurement", "verification evidence", "audit trail"],
    source: "Issue #1",
    requiredLocales: ["en"],
  },
];

// ── Helper Functions ──────────────────────────────────────────────────────

/**
 * Get a material term entry by English term
 */
export function getMaterialTermEntry(englishTerm: string): MaterialTermEntry | undefined {
  return MATERIAL_TERMS.find(t => t.englishTerm === englishTerm);
}

/**
 * Get translated term in a specific locale
 * 
 * @param englishTerm - The authoritative English term
 * @param locale - IETF language tag (e.g., 'es', 'fr', 'de')
 * @returns Translated term, or undefined if not available
 */
export function getMaterialTermTranslation(englishTerm: string, locale: string): string | undefined {
  const entry = getMaterialTermEntry(englishTerm);
  if (!entry) return undefined;
  
  const translation = entry.translations[locale];
  if (!translation) return undefined;
  
  return translation.term;
}

/**
 * Check if a term has been translated to all required locales
 */
export function isMaterialTermFullyTranslated(englishTerm: string): boolean {
  const entry = getMaterialTermEntry(englishTerm);
  if (!entry) return false;
  
  return entry.requiredLocales.every(locale => {
    const translation = entry.translations[locale];
    return translation && !translation.incomplete;
  });
}

/**
 * Get list of all material terms that are not fully translated
 */
export function getUntranslatedMaterialTerms(): Array<{
  term: string;
  missingLocales: string[];
}> {
  return MATERIAL_TERMS
    .filter(entry => !isMaterialTermFullyTranslated(entry.englishTerm))
    .map(entry => ({
      term: entry.englishTerm,
      missingLocales: entry.requiredLocales.filter(
        locale => !entry.translations[locale] || entry.translations[locale].incomplete
      ),
    }));
}
