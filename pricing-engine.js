// ============================================================
// CCB Pricing Engine -- server-side port of the Commission
// Tracker Excel workbook (Rates tab + Pricing Calculator +
// Custom Boxes). Single source of truth for the Quotes tool.
// ============================================================

// ---- Rates tab qty-break tables (breakpoint = min qty for that row) ----

const SCREEN_PRINT = {
  breaks: [1, 6, 12, 24, 48, 72, 144, 288, 576, 1200, 2400, 4800, 9600, 15000],
  cols: ['1 Color', '2 Color', '3 Color', '4 Color', '5 Color', '6 Color', '7 Color'],
  rows: [
    [2, 3.61, 5.56, 7.29, 8.82, 10.99, 12.8],
    [1.36, 1.85, 2.35, 2.84, 3.34, 3.83, 4.32],
    [0.99, 1.28, 1.73, 2.03, 2.35, 2.62, 2.84],
    [0.74, 1.05, 1.32, 1.6, 1.87, 2.14, 2.42],
    [0.7, 0.91, 1.16, 1.38, 1.6, 1.76, 1.95],
    [0.66, 0.84, 0.91, 1.05, 1.32, 1.6, 1.87],
    [0.49, 0.62, 0.71, 0.89, 1.03, 1.3, 1.38],
    [0.45, 0.52, 0.6, 0.65, 0.72, 0.8, 1.07],
    [0.41, 0.47, 0.54, 0.6, 0.64, 0.72, 0.91],
    [0.37, 0.41, 0.45, 0.49, 0.54, 0.58, 0.62],
    [0.33, 0.37, 0.41, 0.45, 0.49, 0.54, 0.58],
    [0.31, 0.35, 0.39, 0.43, 0.47, 0.52, 0.56],
    [0.29, 0.33, 0.37, 0.41, 0.45, 0.49, 0.54],
    [0.27, 0.31, 0.35, 0.39, 0.43, 0.47, 0.52],
  ],
};

const EMBROIDERY = {
  breaks: [1, 13, 48, 100, 251, 501, 1001],
  cols: ['Up to 5K', '5K-10K', '10K-15K', '15K-25K', '25K-30K'],
  rows: [
    [2, 2.46, 2.91, 3.37, 3.83],
    [1.77, 2.23, 2.69, 3.14, 3.6],
    [1.54, 2, 2.46, 2.91, 3.37],
    [1.31, 1.77, 2.23, 2.69, 3.14],
    [1.09, 1.54, 2, 2.46, 2.91],
    [0.77, 1.31, 1.77, 2.23, 2.69],
    [0.63, 1.09, 1.54, 2, 2.46],
  ],
  maxQty: 2500, // above this: CALL FOR QUOTE
};

const DTG = {
  breaks: [1, 13, 48, 100, 251, 501, 1001],
  cols: ['Under 4 in', '4-12 in', '12-18 in'],
  rows: [
    [2, 2.3, 2.59],
    [1.63, 1.93, 2.22],
    [1.41, 1.7, 2],
    [1.26, 1.56, 1.85],
    [1.11, 1.41, 1.7],
    [0.96, 1.26, 1.56],
    [0.81, 1.11, 1.41],
  ],
};

const NYLON_BAGS = {
  breaks: [1, 10, 25, 48, 100],
  cols: ['1 Color', '2 Color', '3 Color', '4 Color'],
  rows: [
    [2, 2.31, 2.62, 2.92],
    [1.23, 1.54, 1.85, 2.15],
    [1, 1.31, 1.62, 1.92],
    [0.69, 0.92, 1.15, 1.38],
    [0.46, 0.69, 0.92, 1.15],
  ],
};

const NUMBERING = {
  breaks: [1, 12, 24, 48, 73, 145],
  cols: ['1 Color', '2 Color'],
  rows: [
    [2, 4],
    [1.75, 3.5],
    [1.5, 3],
    [1.25, 2.5],
    [1.13, 2],
    [0.88, 1.5],
  ],
};

const PATCH = {
  breaks: [1, 13, 48, 100, 251, 501, 1001],
  cols: ['Under 4 in', '4-12 in', '12-18 in'],
  rows: [
    [6.75, 7.75, 8.75],
    [5.5, 6.5, 7.5],
    [4.75, 5.75, 6.75],
    [4.25, 5.25, 6.25],
    [3.75, 4.75, 5.75],
    [3.25, 4.25, 5.25],
    [2.75, 3.75, 4.75],
  ],
};

const ENGRAVING_FLAT = 1.5;

const SCREEN_FEES = {
  Regular: { New: 20, Reorder: 10 },
  'Large / Oversized': { New: 30, Reorder: 20 },
};

const ADDITIONAL_FEES = {
  artPerHour: 50,
  rushFlat: 75,
  baggingPerItem: 0.5,
};

const COMMISSION_TIERS = {
  newClientRate: 0.20,
  standardRate: 0.15,
  loyaltyRate: 0.25,
  loyaltyThreshold: 50000,
};

const DECORATION_TYPES = [
  'Screen Print', 'Embroidery', 'DTG / Direct to Film',
  'Nylon Jackets & Bags', 'Numbering', 'Engraving', 'Patch',
];

// VLOOKUP with TRUE (approximate match): find the largest breakpoint <= qty
function tierRowFor(breaks, qty) {
  let idx = -1;
  for (let i = 0; i < breaks.length; i++) {
    if (qty >= breaks[i]) idx = i;
    else break;
  }
  return idx;
}

// Returns { cost, error } -- cost is $/unit, error is a user-facing message like Excel's cell text
function decoCostPerUnit(type, qty, colorOrSize) {
  if (!type) return { cost: 0, error: null };
  if (!qty || qty <= 0) return { cost: null, error: 'fill qty' };

  switch (type) {
    case 'Screen Print': {
      if (!colorOrSize) return { cost: null, error: 'fill colors' };
      const colIdx = SCREEN_PRINT.cols.indexOf(colorOrSize);
      if (colIdx === -1) return { cost: null, error: 'check colors' };
      const rowIdx = tierRowFor(SCREEN_PRINT.breaks, qty);
      if (rowIdx === -1) return { cost: null, error: 'check colors' };
      return { cost: SCREEN_PRINT.rows[rowIdx][colIdx], error: null };
    }
    case 'Embroidery': {
      if (!colorOrSize) return { cost: null, error: 'fill stitch' };
      if (qty > EMBROIDERY.maxQty) return { cost: null, error: 'CALL FOR QUOTE' };
      const colIdx = EMBROIDERY.cols.indexOf(colorOrSize);
      if (colIdx === -1) return { cost: null, error: 'check stitch' };
      const rowIdx = tierRowFor(EMBROIDERY.breaks, qty);
      if (rowIdx === -1) return { cost: null, error: 'check stitch' };
      return { cost: EMBROIDERY.rows[rowIdx][colIdx], error: null };
    }
    case 'DTG / Direct to Film': {
      if (!colorOrSize) return { cost: null, error: 'fill size' };
      const colIdx = DTG.cols.indexOf(colorOrSize);
      if (colIdx === -1) return { cost: null, error: 'check size' };
      const rowIdx = tierRowFor(DTG.breaks, qty);
      if (rowIdx === -1) return { cost: null, error: 'check size' };
      return { cost: DTG.rows[rowIdx][colIdx], error: null };
    }
    case 'Nylon Jackets & Bags': {
      if (!colorOrSize) return { cost: null, error: 'fill colors' };
      const colIdx = NYLON_BAGS.cols.indexOf(colorOrSize);
      if (colIdx === -1) return { cost: null, error: 'check colors' };
      const rowIdx = tierRowFor(NYLON_BAGS.breaks, qty);
      if (rowIdx === -1) return { cost: null, error: 'check colors' };
      return { cost: NYLON_BAGS.rows[rowIdx][colIdx], error: null };
    }
    case 'Numbering': {
      if (!colorOrSize) return { cost: null, error: 'fill colors' };
      const colIdx = NUMBERING.cols.indexOf(colorOrSize);
      if (colIdx === -1) return { cost: null, error: 'check colors' };
      const rowIdx = tierRowFor(NUMBERING.breaks, qty);
      if (rowIdx === -1) return { cost: null, error: 'check colors' };
      return { cost: NUMBERING.rows[rowIdx][colIdx], error: null };
    }
    case 'Engraving': {
      return { cost: ENGRAVING_FLAT, error: null };
    }
    case 'Patch': {
      if (!colorOrSize) return { cost: null, error: 'fill size' };
      const colIdx = PATCH.cols.indexOf(colorOrSize);
      if (colIdx === -1) return { cost: null, error: 'check size' };
      const rowIdx = tierRowFor(PATCH.breaks, qty);
      if (rowIdx === -1) return { cost: null, error: 'check size' };
      return { cost: PATCH.rows[rowIdx][colIdx], error: null };
    }
    default:
      return { cost: 0, error: null };
  }
}

function screenFee(count, sizeKey, orderType) {
  if (!count || count <= 0) return 0;
  const key = orderType === 'Reorder' ? 'Reorder' : 'New';
  return count * SCREEN_FEES[sizeKey][key];
}

// ---- Garment/decoration line item (mirrors Pricing Calculator tab) ----
// input: {
//   quantity, orderType, garmentCostPerUnit, sellPricePerUnit,
//   screensRegular, screensLarge, rushFeeFlat, artHours,
//   decorations: [{type, colorOrSize}, {type, colorOrSize}, {type, colorOrSize}]  (up to 3)
// }
function computeGarmentLine(input) {
  const qty = Number(input.quantity) || 0;
  const sell = Number(input.sellPricePerUnit) || 0;
  const orderType = input.orderType || 'New Order';
  const garmentCost = Number(input.garmentCostPerUnit) || 0;

  const decoResults = (input.decorations || []).slice(0, 3).map(d =>
    d && d.type ? decoCostPerUnit(d.type, qty, d.colorOrSize) : { cost: 0, error: null }
  );
  const decoErrors = decoResults.filter(r => r.error).map(r => r.error);
  const decoCostTotal = decoResults.reduce((s, r) => s + (r.cost || 0), 0);

  const rushFee = input.rushFeeFlat != null ? Number(input.rushFeeFlat) : 0;
  const artFee = (Number(input.artHours) || 0) * ADDITIONAL_FEES.artPerHour;
  const screenFeesRegular = screenFee(Number(input.screensRegular) || 0, 'Regular', orderType);
  const screenFeesLarge = screenFee(Number(input.screensLarge) || 0, 'Large / Oversized', orderType);
  const totalSetupFees = screenFeesRegular + screenFeesLarge + rushFee + artFee;
  const setupCostPerUnit = qty > 0 ? totalSetupFees / qty : 0;

  const cogsRate = 0.20;
  const cogsPerUnit = sell * cogsRate; // "COGS+" -- scales with current sell price, mirrors Excel's own circularity

  const totalCostPerUnit = decoCostTotal + garmentCost + cogsPerUnit + setupCostPerUnit;
  const fixedCostPerUnit = totalCostPerUnit - cogsPerUnit; // deco+garment+setup only

  const minFloor = fixedCostPerUnit / (0.7 - cogsRate);      // 30% margin floor
  const suggested35 = fixedCostPerUnit / (0.65 - cogsRate);  // 35% suggested
  const max50 = fixedCostPerUnit / (0.5 - cogsRate);         // 50% ceiling

  const totalRevenue = sell * qty;
  const totalCost = totalCostPerUnit * qty;
  const grossProfit = totalRevenue - totalCost;
  const grossMarginPct = sell > 0 ? 1 - (totalCostPerUnit / sell) : null;

  return {
    decoCostPerUnit: decoCostTotal,
    decoErrors,
    garmentCostPerUnit: garmentCost,
    screenFeesRegular, screenFeesLarge, rushFee, artFee,
    totalSetupFees, setupCostPerUnit,
    cogsPerUnit,
    totalCostPerUnit,
    minFloor, suggested35, max50,
    sellPricePerUnit: sell,
    totalRevenue, totalCost, grossProfit, grossMarginPct,
    meetsFloor: sell > 0 && minFloor != null ? sell >= minFloor : null,
  };
}

// ---- Custom Box line item (mirrors Custom Boxes tab) ----
function computeBoxLine(input) {
  const qty = Number(input.quantity) || 0;
  const sell = Number(input.sellPricePerUnit) || 0;
  const boxCost = 2.25;
  const peopleOverhead = qty > 0 ? (qty < 25 ? 2 : 1) : 0;
  const setupCost = Number(input.setupCostPerUnit) || 0;
  const overheadRate = 0.20;
  const overheadPerUnit = sell * overheadRate;

  const totalCostPerUnit = boxCost + peopleOverhead + setupCost + overheadPerUnit;
  const minFloor = totalCostPerUnit / 0.6;        // 40% margin floor (as coded in the workbook)
  const suggested45 = totalCostPerUnit / 0.55;

  const totalRevenue = sell * qty;
  const totalCost = totalCostPerUnit * qty;
  const grossProfit = totalRevenue - totalCost;
  const grossMarginPct = sell > 0 ? 1 - (totalCostPerUnit / sell) : null;

  return {
    boxCost, peopleOverhead, setupCost, overheadPerUnit,
    totalCostPerUnit, minFloor, suggested45,
    sellPricePerUnit: sell,
    totalRevenue, totalCost, grossProfit, grossMarginPct,
    meetsFloor: sell > 0 ? sell >= minFloor : null,
  };
}

// ---- Commission rate ----
// clientOrderCount: number of PRIOR promoted orders for this client, company-wide (0 = this is their first order)
// rolling12moRevenue: this client's revenue from orders in the last 365 days, NOT including this quote
function computeCommissionRate(clientOrderCount, rolling12moRevenue) {
  const rev = Number(rolling12moRevenue) || 0;
  if (rev >= COMMISSION_TIERS.loyaltyThreshold) {
    return { rate: COMMISSION_TIERS.loyaltyRate, tier: 'Loyalty (25%)' };
  }
  if (clientOrderCount === 0) {
    return { rate: COMMISSION_TIERS.newClientRate, tier: 'New Client (20%)' };
  }
  return { rate: COMMISSION_TIERS.standardRate, tier: 'Standard (15%)' };
}

module.exports = {
  DECORATION_TYPES,
  SCREEN_PRINT, EMBROIDERY, DTG, NYLON_BAGS, NUMBERING, PATCH,
  ADDITIONAL_FEES, COMMISSION_TIERS,
  decoCostPerUnit, screenFee,
  computeGarmentLine, computeBoxLine, computeCommissionRate,
};
