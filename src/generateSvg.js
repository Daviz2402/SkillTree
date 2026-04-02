const fs = require('fs');
const path = require('path');

const configPath = process.argv[2] || process.env.INPUT_CONFIG_PATH || path.join(__dirname, '../config/skills.json');
const outputPath = process.argv[3] || process.env.INPUT_OUTPUT_PATH || path.join(__dirname, '../output/skill-tree.svg');

if (!fs.existsSync(configPath)) {
    console.error(`❌ Error: Configuration file not found at ${configPath}`);
    process.exit(1);
}
const rawData = fs.readFileSync(configPath);
const data = JSON.parse(rawData);

class BoundingBox {
    constructor() { this.minX = Infinity; this.minY = Infinity; this.maxX = -Infinity; this.maxY = -Infinity; }
    add(x, y, r = 0) {
        this.minX = Math.min(this.minX, x - r); this.maxX = Math.max(this.maxX, x + r);
        this.minY = Math.min(this.minY, y - r); this.maxY = Math.max(this.maxY, y + r);
    }
}

function getRarityColor(rarity, categoryColor) {
    const colors = { common: '#888', rare: '#58a6ff', epic: '#bc8cff', legendary: '#ffc107', category: categoryColor };
    return colors[rarity] || categoryColor;
}

function getHexPath(cx, cy, size) {
    let pts = [];
    for (let i = 0; i < 6; i++) {
        let a = (Math.PI / 3) * i + (Math.PI / 6);
        pts.push(`${cx + size * Math.cos(a)},${cy + size * Math.sin(a)}`);
    }
    return `M ${pts.join(' L ')} Z`;
}

function getPolygonVertices(cx, cy, radius, sides, rotationRad) {
    let actualSides = Math.max(3, sides);
    let vertices = [];
    for (let i = 0; i < actualSides; i++) {
        let angle = rotationRad + (i * 2 * Math.PI) / actualSides;
        vertices.push({ x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle), angle: angle, index: i });
    }
    return vertices;
}

function getVerticesPath(v) { return `M ${v.map(p => `${p.x},${p.y}`).join(' L ')} Z`; }

// Resolves label position/size from a `label` config object + node center
function resolveLabel(cx, cy, nodeRadius, labelCfg, defaultText, defaultSize = 11) {
    const pos = (labelCfg && labelCfg.position) || "center";
    const size = (labelCfg && labelCfg.size) || (pos === "center" ? defaultSize : 14);
    const text = (labelCfg && labelCfg.text) !== undefined ? labelCfg.text : defaultText;
    const gap = nodeRadius + 20;
    let x = cx, y = cy, anchor = "middle";
    if (pos === "down") { x = cx; y = cy + gap; anchor = "middle"; }
    if (pos === "up") { x = cx; y = cy - gap; anchor = "middle"; }
    if (pos === "left") { x = cx - gap; y = cy + 4; anchor = "end"; }
    if (pos === "right") { x = cx + gap; y = cy + 4; anchor = "start"; }
    if (pos === "center") { x = cx; y = cy + size / 3; anchor = "middle"; }
    return { x, y, anchor, size, text };
}

// Estimates the minimum node CIRCUMRADIUS so the label text fits inside the polygon when position=center.
// Accounts for: letter-spacing CSS (1.5px), polygon geometry (apothem < circumradius for non-circles).
function textFitRadius(text, fontSize, padding, sides) {
    const LETTER_SPACING = 1.5; // matches the global CSS
    const charWidth = fontSize * 0.62 + LETTER_SPACING;
    const estimatedHalfWidth = Math.ceil((text || '').length * charWidth / 2);
    // For a regular polygon with n sides, the largest inscribed horizontal span
    // at the center is the apothem: apothem = R * cos(π/n)
    // So we need R = estimatedHalfWidth / cos(π/n)
    const n = Math.max(3, sides || 36);
    const geomFactor = 1 / Math.cos(Math.PI / n); // ≈1 for circles, ≈1.15 for hex, ≈2 for triangle
    return Math.ceil(estimatedHalfWidth * geomFactor) + (padding || 10);
}

function getJoinPath(x1, y1, x2, y2, centerX, centerY, curvature = 60) {
    const dx = (x1 + x2) / 2 - centerX, dy = (y1 + y2) / 2 - centerY;
    const mag = Math.hypot(dx, dy) || 1;
    const cpx = (x1 + x2) / 2 + (dx / mag) * curvature, cpy = (y1 + y2) / 2 + (dy / mag) * curvature;
    return `M ${x1} ${y1} Q ${cpx} ${cpy}, ${x2} ${y2}`;
}

const isDebug = data.theme ? (data.theme.debug === true) : false;
const isRevealAll = data.theme ? (data.theme.revealAll === true) : false;
const isGlow = data.theme ? (data.theme.glow !== false) : true;
const nC = (isDebug || isRevealAll) ? 'revealed-node' : 'hidden-node';
const lC = (isDebug || isRevealAll) ? 'revealed-line' : 'hidden-line';
const sC = (isDebug || isRevealAll) ? 'unlocked energy' : 'locked';

// Theme Sizes
const sizes = data.theme.sizes || {};
const CORE_R = sizes.coreRadius || 65;
const CORE_INNER_R = CORE_R * 0.86;
const CORE_T = sizes.coreText || 16;
const CAT_R = sizes.categoryRadius || 85;
const CAT_T = sizes.categoryText || 11;
const SKILL_R = sizes.skillRadius || 36;
const SKILL_T = sizes.skillText || 11;

function generateSVG(data) {
    const bbox = new BoundingBox();
    const centerX = 0, centerY = 0;
    const coreColor = data.theme.primary || '#58a6ff';
    const coreRotation = (data.theme.coreRotation || 0) * (Math.PI / 180) - Math.PI / 2;
    const coreVertices = getPolygonVertices(centerX, centerY, CORE_R, data.categories.length, coreRotation);
    const coreInner = getPolygonVertices(centerX, centerY, CORE_INNER_R, data.categories.length, coreRotation);
    coreVertices.forEach(v => bbox.add(v.x, v.y, 20));

    const categories = [];
    const coreVertexLoad = {};
    data.categories.forEach((cat, i) => {
        let vIdx = cat.start !== undefined ? cat.start : (cat.vertex !== undefined ? cat.vertex : i);
        if (vIdx >= coreVertices.length) vIdx = 0;
        coreVertexLoad[vIdx] = (coreVertexLoad[vIdx] || 0) + 1;
        const tip = coreVertices[vIdx];
        const dist = 220 + (coreVertexLoad[vIdx] * 95);
        const x = centerX + dist * Math.cos(tip.angle), y = centerY + dist * Math.sin(tip.angle);
        const vCount = Math.max(3, cat.skills.length + 1);
        const rot = tip.angle + Math.PI + (cat.rotation || 0) * (Math.PI / 180);
        // Responsive radius: grow to fit center label text
        const catLblPos = (cat.label && cat.label.position) || "center";
        const catLblTxt = (cat.label && cat.label.text !== undefined) ? cat.label.text : cat.name.toUpperCase();
        const catLblSize = (cat.label && cat.label.size) || CAT_T;
        const BASE_CAT_R = cat.radius || CAT_R;
        const catRadius = catLblPos === "center" ? Math.max(BASE_CAT_R, textFitRadius(catLblTxt, catLblSize, 14, vCount)) : BASE_CAT_R;
        const vts = getPolygonVertices(x, y, catRadius, vCount, rot);
        categories.push({ name: cat.name, x, y, angle: tip.angle, vertices: vts, color: cat.color || coreColor, coreVIdx: vIdx, data: cat, computedRadius: catRadius });
        vts.forEach(v => bbox.add(v.x, v.y, 40));
    });

    const skillsMap = new Map();
    const occupiedVertices = categories.map(() => new Set());
    data.categories.forEach((cat, catIdx) => {
        const category = categories[catIdx];
        const vLoad = {};
        cat.skills.forEach((s, sIdx) => {
            let vi = s.start !== undefined ? s.start : (s.vertex !== undefined ? s.vertex : (sIdx % category.vertices.length));
            if (vi >= category.vertices.length) vi = 0;
            occupiedVertices[catIdx].add(vi);
            vLoad[vi] = (vLoad[vi] || 0) + 1;
            const vt = category.vertices[vi];
            const hx = vt.x + (110 * vLoad[vi]) * Math.cos(vt.angle), hy = vt.y + (110 * vLoad[vi]) * Math.sin(vt.angle);
            if (!skillsMap.has(s.name)) skillsMap.set(s.name, { name: s.name, data: s, instances: [{ hx, hy, catIdx, vIndex: vi, vertex: vt, raw: s }] });
            else skillsMap.get(s.name).instances.push({ hx, hy, catIdx, vIndex: vi, vertex: vt, raw: s });
        });
    });

    categories.forEach((cat, idx) => {
        const tip = coreVertices[cat.coreVIdx];
        let bestV = null, minDist = Infinity;
        cat.vertices.forEach((v, vi) => { if (!occupiedVertices[idx].has(vi)) { const d = Math.hypot(v.x - tip.x, v.y - tip.y); if (d < minDist) { minDist = d; bestV = v; } } });
        if (!bestV) { minDist = Infinity; cat.vertices.forEach(v => { const d = Math.hypot(v.x - tip.x, v.y - tip.y); if (d < minDist) { minDist = d; bestV = v; } }); }
        cat.coreContact = bestV;
    });

    skillsMap.forEach(s => {
        let sx = 0, sy = 0; s.instances.forEach(i => { sx += i.hx; sy += i.hy; });
        s.x = sx / s.instances.length; s.y = sy / s.instances.length;
        s.idTag = s.name.replace(/[^a-z0-9]/gi, '_'); bbox.add(s.x, s.y, 80);
    });

    const pad = 50;
    const vbX = bbox.minX - pad, vbY = bbox.minY - pad, vbW = bbox.maxX - bbox.minX + 2 * pad, vbH = bbox.maxY - bbox.minY + 2 * pad;
    const grid = "rgba(255,255,255,0.08)";

    let svg = [`<svg viewBox="${vbX} ${vbY} ${vbW} ${vbH}" xmlns="http://www.w3.org/2000/svg">`,
    `<defs><pattern id="grid" width="80" height="auto" patternUnits="userSpaceOnUse"><path d="M 80 0 L 0 0 0 80" fill="none" stroke="${grid}" stroke-width="1.5"/></pattern></defs>`,
    `<style>text{font-family:"Segoe UI",sans-serif;fill:${data.theme.text};font-size:15px;letter-spacing:1.5px;pointer-events:none;}.node{transform-origin:center;transform-box:fill-box;}.line{stroke-dasharray:1000;stroke-dashoffset:1000;}.hidden-node{opacity:0;pointer-events:none;transform:scale(0.5);transition:all 0.5s cubic-bezier(0.175,0.885,0.32,1.275);}.revealed-node{opacity:1;pointer-events:auto;transform:scale(1);}.hidden-line{opacity:0;}.revealed-line{opacity:1!important;animation:dL 1.5s forwards;}.skill-line{transition:all .4s;stroke-opacity:.15;}@keyframes dL{to{stroke-dashoffset:0;}}.energy{stroke-dasharray:6 12;animation:fL 3s linear infinite;}@keyframes fL{to{stroke-dashoffset:-36;}}.interactive{cursor:pointer;}.locked{filter:grayscale(1) brightness(.5);transition:all .4s;}.locked:hover{filter:grayscale(.2) brightness(1);transform:scale(1.08);}.unlocked{filter:${isGlow ? 'drop-shadow(0 0 15px var(--skill-color))' : 'none' };}.unlocked-anim{animation:uP .8s forwards;}@keyframes uP{0%{transform:scale(1);}50%{transform:scale(1.5);}100%{transform:scale(1);}}.unlocked .hex-bg{fill:var(--skill-color)!important;fill-opacity:.2!important;}.unlocked .hex-border{stroke-opacity:1!important;stroke-width:3.5!important;}.unlocked .skill-text{fill:#fff !important;font-weight:bold;text-shadow:${isGlow ? '0 0 10px var(--skill-color)' : 'none' };}.unlocked .lock-icon{opacity:0;}.hud-box{fill:rgba(0,0,15,.96);stroke:${data.theme.primary || '#58a6ff'};stroke-width:1.5;}.skill.locked .hex-border { stroke: #444 !important; }
        .skill.locked .skill-text { fill: #fff !important; }
        .revealed-line.join-line, .join-line.energy { 
            animation-name: flow;
            animation-duration: var(--anim-speed, 0.6s);
            animation-timing-function: linear;
            animation-iteration-count: infinite;
        }
        @keyframes flow { to { stroke-dashoffset: -40; } }
    </style>`,
    `<rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="${data.theme.background}"/><rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="url(#grid)"/>`];

    const coreLbl = data.theme.coreLabel || "ORIGIN";
    const coreLines = coreLbl.split(/\\n|\n/);
    const coreFontSize = CORE_T;
    const coreStartDy = -((coreLines.length - 1) * coreFontSize * 0.6); // slight vertical adjustment
    const coreTextFrag = coreLines.map((l, i) => `<tspan x="0" dy="${i === 0 ? coreStartDy : '1.2em'}" text-anchor="middle">${l.toUpperCase()}</tspan>`).join("");

    const coreGlow = isGlow ? `filter="drop-shadow(0 0 15px ${coreColor})"` : "";
    svg.push(`<g id="core-node" class="node interactive" onclick="handleClick(this)"><path d="${getVerticesPath(coreVertices)}" fill="#000" stroke="${coreColor}" stroke-width="4" ${coreGlow}/><path d="${getVerticesPath(coreInner)}" fill="none" stroke="${coreColor}" stroke-opacity=".5" stroke-width="2" class="energy" /><text x="0" y="${centerY}" alignment-baseline="middle" font-weight="bold" fill="#fff" style="font-size:${coreFontSize}px;letter-spacing:3px;">${coreTextFrag}</text></g>`);

    categories.forEach((cat, idx) => {
        const coreV = coreVertices[cat.coreVIdx];
        const depth = (Object.values(categories.slice(0, idx + 1)).filter(c => c.coreVIdx === cat.coreVIdx).length);
        const prev = depth === 1 ? coreV : { x: centerX + (220 + (depth - 1) * 90) * Math.cos(coreV.angle), y: centerY + (220 + (depth - 1) * 90) * Math.sin(coreV.angle) };
        svg.push(`<path class="line cat-line ${lC}" d="M ${prev.x} ${prev.y} L ${cat.coreContact.x} ${cat.coreContact.y}" stroke="${cat.color}" stroke-opacity=".5" stroke-width="3" fill="none"/>`);
    });

    categories.forEach(cat => {
        const lbl = resolveLabel(cat.x, cat.y, cat.computedRadius, cat.data ? cat.data.label : null, cat.name.toUpperCase(), CAT_T);
        const catGlow = isGlow ? `filter="drop-shadow(0 0 10px ${cat.color})"` : "";
        svg.push(`<g class="node cat-node ${nC} interactive" data-name="${cat.name}" onclick="handleClick(this)"><path d="${getVerticesPath(cat.vertices)}" fill="#000" stroke="${cat.color}" stroke-width="4" ${catGlow}/><text x="${lbl.x}" y="${lbl.y}" text-anchor="${lbl.anchor}" font-weight="bold" fill="${cat.color}" style="font-size:${lbl.size}px;">${lbl.text}</text></g>`);
        if (isDebug) {
            cat.vertices.forEach((v, i) => {
                svg.push(`<circle cx="${v.x}" cy="${v.y}" r="12" fill="red" opacity="0.8"/><text x="${v.x}" y="${v.y + 4}" font-size="12" fill="white" font-weight="bold" text-anchor="middle" pointer-events="none">${i}</text>`);
            });
        }
    });

    // Calculate Skill Connections for Dynamic Geometry
    skillsMap.forEach(s => { s.connectionCount = s.instances.length + (s.data.joins ? s.data.joins.length : 0); });
    skillsMap.forEach(s => {
        if (s.data.joins) {
            s.data.joins.forEach(j => {
                const tN = typeof j === 'object' ? j.name : j;
                if (skillsMap.has(tN)) skillsMap.get(tN).connectionCount++;
            });
        }
    });

    skillsMap.forEach(s => {
        if (s.data.sides !== undefined) {
            s.sides = s.data.sides;
        } else if (s.connectionCount === 1) {
            s.sides = 36;
        } else if (s.connectionCount === 2) {
            s.sides = 6;
        } else {
            s.sides = Math.max(3, s.connectionCount);
        }
        s.shapeRotation = s.data.rotation !== undefined ? s.data.rotation : Math.PI / s.sides;
        // Responsive radius: grow to fit center label text
        const sLblPos = (s.data.label && s.data.label.position) || "center";
        const sLblTxt = (s.data.label && s.data.label.text !== undefined) ? s.data.label.text : s.name;
        const sLblSize = (s.data.label && s.data.label.size) || SKILL_T;
        const BASE_SKILL_R = s.data.radius || SKILL_R;
        s.computedRadius = sLblPos === "center" ? Math.max(BASE_SKILL_R, textFitRadius(sLblTxt, sLblSize, 10, s.sides)) : BASE_SKILL_R;
    });

    skillsMap.forEach(s => {
        const sPts = getPolygonVertices(s.x, s.y, s.computedRadius, s.sides, s.shapeRotation);
        s.instances.forEach(i => {
            let bV = sPts[0];
            if (i.raw.end !== undefined) {
                bV = sPts[i.raw.end % s.sides] || sPts[0];
            } else if (i.raw.anchor !== undefined) {
                bV = sPts[i.raw.anchor % s.sides] || sPts[0];
            } else {
                let mD = Infinity;
                sPts.forEach(v => { const d = Math.hypot(v.x - i.vertex.x, v.y - i.vertex.y); if (d < mD) { mD = d; bV = v; } });
            }
            const nodeCol = s.data.color || categories[i.catIdx].color;

            // Inherit style/speed from the skill node for the base line too
            const bLineStyle = s.data.style || "solid";
            const bLineSpeed = s.data.speed !== undefined ? s.data.speed : 0;
            let bLineDash = "none";
            if (bLineStyle === "dashed") bLineDash = "12 10";
            else if (bLineStyle === "dotted") bLineDash = "3 8";
            else if (bLineStyle === "sparse") bLineDash = "20 20";
            let bLineDir = "normal";
            if (s.data.direction === "reverse" || s.data.direction === "node-in") bLineDir = "reverse";
            if (s.data.direction === "alternate") bLineDir = "alternate";
            let bLineInlineStyle = `stroke-dasharray: ${bLineDash}; `;
            bLineInlineStyle += bLineSpeed > 0 ? `animation: flow ${bLineSpeed}s linear infinite ${bLineDir}; ` : `animation: none; `;

            svg.push(`<path data-link="${s.idTag}" data-parent="${categories[i.catIdx].name}" class="skill-line-base line ${lC}" style="${bLineInlineStyle}" d="M ${i.vertex.x} ${i.vertex.y} L ${bV.x} ${bV.y}" stroke="${nodeCol}" stroke-width="3.5" stroke-opacity="${isDebug ? 1 : 0.15}" fill="none"/>`);
        });
    });

    // UPDATED JOIN LOGIC: Targeting Nodes directly
    skillsMap.forEach(s => {
        if (s.data.joins) {
            s.data.joins.forEach((j, jc) => {
                const isO = typeof j === 'object', tN = isO ? j.name : j;
                const tS = skillsMap.get(tN), tC = categories.find(c => c.name === tN);
                let p2 = null, col = s.data.color || categories[s.instances[0].catIdx].color;
                const sPts = getPolygonVertices(s.x, s.y, s.computedRadius, s.sides, s.shapeRotation);

                if (tS) {
                    const tPts = getPolygonVertices(tS.x, tS.y, tS.computedRadius, tS.sides, tS.shapeRotation);
                    if (isO && j.end !== undefined) {
                        p2 = tPts[j.end % tS.sides] || tPts[0];
                    } else if (isO && j.vertex !== undefined) {
                        p2 = tPts[j.vertex % tS.sides] || tPts[0];
                    } else {
                        let bV = tPts[0], mD = Infinity;
                        tPts.forEach(v => { const d = Math.hypot(v.x - s.x, v.y - s.y); if (d < mD) { mD = d; bV = v; } });
                        p2 = bV;
                    }
                    // Color is already inherited from SOURCE (s.data.color). If you prefer TARGET color:
                    // col = tS.data.color || categories[tS.instances[0].catIdx].color;
                } else if (tC) {
                    if (isO && j.end !== undefined) {
                        p2 = tC.vertices[j.end % tC.vertices.length] || tC.vertices[0];
                    } else if (isO && j.vertex !== undefined) {
                        p2 = tC.vertices[j.vertex % tC.vertices.length] || tC.vertices[0];
                    } else {
                        let bV = tC.vertices[0], mD = Infinity;
                        tC.vertices.forEach(v => { const d = Math.hypot(v.x - s.x, v.y - s.y); if (d < mD) { mD = d; bV = v; } });
                        p2 = bV;
                    }
                    // col = tC.color; // Removed to inherit flow color from the SOURCE
                }

                if (p2) {
                    let p1 = sPts[0];
                    if (isO && j.start !== undefined) {
                        p1 = sPts[j.start % s.sides] || sPts[0];
                    } else if (isO && j.source !== undefined) {
                        p1 = sPts[j.source % s.sides] || sPts[0];
                    } else {
                        let minD1 = Infinity;
                        sPts.forEach(v => { const d = Math.hypot(v.x - p2.x, v.y - p2.y); if (d < minD1) { minD1 = d; p1 = v; } });
                    }
                    const finalCol = (isO && j.color) ? j.color : col;
                    const curv = (isO && j.curvature !== undefined) ? j.curvature : 60;
                    const joinId = `epic-join-${s.idTag}-${j.name.replace(/\D/g, '')}-${jc}`;

                    let dashMap = { "solid": "none", "dotted": "3 6", "dashed": "8 6", "sparse": "20 15", "corrupted": "15 3 3 6 4 9" };
                    const dashVal = (isO && j.style !== undefined) ? (dashMap[j.style] || j.style) : "8 6";
                    const speed = (isO && j.speed !== undefined) ? j.speed : 0.6;
                    const dirArg = (isO && j.direction !== undefined) ? j.direction : "forward";

                    let dirCSS = "normal";
                    if (dirArg === "reverse" || dirArg === "node-in") dirCSS = "reverse";
                    if (dirArg === "alternate") dirCSS = "alternate";

                    const sProps = speed === 0 ? "animation: none;" : `--anim-speed: ${speed}s; animation-direction: ${dirCSS};`;
                    const joinGlow = isGlow ? `filter="drop-shadow(0 0 6px ${finalCol})"` : "";

                    if (dirArg === "both" || dirArg === "center-out" || dirArg === "center-in") {
                        const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
                        const ang = Math.atan2(p2.y - p1.y, p2.x - p1.x) + Math.PI / 2;
                        const cP = { x: mx + Math.cos(ang) * curv, y: my + Math.sin(ang) * curv };

                        const Q1 = { x: (p1.x + cP.x) / 2, y: (p1.y + cP.y) / 2 };
                        const R1 = { x: (cP.x + p2.x) / 2, y: (cP.y + p2.y) / 2 };
                        const C = { x: (p1.x + 2 * cP.x + p2.x) / 4, y: (p1.y + 2 * cP.y + p2.y) / 4 };

                        let pathA, pathB;
                        if (dirArg === "center-in") {
                            pathA = `M ${p1.x} ${p1.y} Q ${Q1.x} ${Q1.y} ${C.x} ${C.y}`;
                            pathB = `M ${p2.x} ${p2.y} Q ${R1.x} ${R1.y} ${C.x} ${C.y}`;
                        } else {
                            pathA = `M ${C.x} ${C.y} Q ${Q1.x} ${Q1.y} ${p1.x} ${p1.y}`;
                            pathB = `M ${C.x} ${C.y} Q ${R1.x} ${R1.y} ${p2.x} ${p2.y}`;
                        }

                        svg.push(`<path id="${joinId}-A" data-link="${s.idTag}" data-source="${s.idTag}" class="join-line skill-line line ${lC}" style="${sProps} stroke-dasharray: ${dashVal};" d="${pathA}" stroke="${finalCol}" stroke-opacity="${isDebug ? 1 : 0.1}" stroke-width="3" ${joinGlow} fill="none"/>`);
                        svg.push(`<path id="${joinId}-B" data-link="${s.idTag}" data-source="${s.idTag}" class="join-line skill-line line ${lC}" style="${sProps} stroke-dasharray: ${dashVal};" d="${pathB}" stroke="${finalCol}" stroke-opacity="${isDebug ? 1 : 0.1}" stroke-width="3" ${joinGlow} fill="none"/>`);

                        if (j.label) {
                            svg.push(`<path id="${joinId}-txt" d="${getJoinPath(p1.x, p1.y, p2.x, p2.y, centerX, centerY, curv)}" fill="none" stroke="none" />`);
                            svg.push(`<text data-source="${s.idTag}" class="join-label ${lC}" filter="drop-shadow(0 0 5px ${finalCol})" style="font-size:12px; font-weight:bold; letter-spacing:4px; pointer-events:none;" fill="${finalCol}"><textPath href="#${joinId}-txt" startOffset="50%" text-anchor="middle" dy="-10">${j.label.toUpperCase()}</textPath></text>`);
                        }
                    } else {
                        svg.push(`<path id="${joinId}" data-link="${s.idTag}" data-source="${s.idTag}" class="join-line skill-line line ${lC}" style="${sProps} stroke-dasharray: ${dashVal};" d="${getJoinPath(p1.x, p1.y, p2.x, p2.y, centerX, centerY, curv)}" stroke="${finalCol}" stroke-opacity="${isDebug ? 1 : 0.1}" stroke-width="3" filter="drop-shadow(0 0 6px ${finalCol})" fill="none"/>`);

                        if (j.label) {
                            svg.push(`<text data-source="${s.idTag}" class="join-label ${lC}" filter="drop-shadow(0 0 5px ${finalCol})" style="font-size:12px; font-weight:bold; letter-spacing:4px; pointer-events:none;" fill="${finalCol}">
                                <textPath href="#${joinId}" startOffset="50%" text-anchor="middle" dy="-10">
                                    ${j.label.toUpperCase()}
                                </textPath>
                            </text>`);
                        }
                    }
                }
            });
        }
    });

    skillsMap.forEach(s => {
        const baseC = s.data.color || categories[s.instances[0].catIdx].color;
        const sc = getRarityColor(s.data.rarity, baseC);
        const lvl = s.data.level || '??';
        const rar = s.data.rarity || 'common';
        const pList = s.instances.map(i => categories[i.catIdx].name).join(',');
        const vts = getPolygonVertices(s.x, s.y, s.computedRadius, s.sides, s.shapeRotation);
        const pPath = getVerticesPath(vts);

        const style = s.data.style || "solid";
        const speed = s.data.speed !== undefined ? s.data.speed : 0;

        let dashVal = "none";
        if (style === "dashed") dashVal = "12 10";
        else if (style === "dotted") dashVal = "3 8";
        else if (style === "sparse") dashVal = "20 20";

        let dirCSS = "normal";
        if (s.data.direction === "reverse" || s.data.direction === "node-in") dirCSS = "reverse";
        if (s.data.direction === "alternate") dirCSS = "alternate";

        // Always write explicit overrides so .energy class CSS cannot bleed into hex-border
        let bStyle = `stroke-dasharray: ${dashVal}; `;
        if (speed > 0) {
            bStyle += `animation: flow ${speed}s linear infinite ${dirCSS}; `;
        } else {
            bStyle += `animation: none; `;
        }

        const lbl = resolveLabel(s.x, s.y, s.computedRadius, s.data.label, s.name, SKILL_T);
        const bStyleBase = isRevealAll ? "stroke-opacity: 1 !important; stroke-width: 3.5 !important; " : "";
        svg.push(`<g class="node skill ${nC} interactive ${sC}" style="--skill-color:${sc}" data-skill-id="${s.idTag}" data-name="${s.name}" data-color="${sc}" data-level="${lvl}" data-rarity="${rar}" data-parents="${pList}" onclick="handleClick(this)"><path class="hex-bg" d="${pPath}" fill="#000"/><path class="hex-border" d="${pPath}" style="${bStyleBase}${bStyle}" fill="none" stroke="${sc}" stroke-opacity=".3" stroke-width="2.5"/><g class="lock-icon" transform="translate(${s.x},${s.y}) scale(.8)"><path d="M -4 -2 v-3 a 4 4 0 0 1 8 0 v3 M -5 -2 h10 v8 h-10 z" fill="none" stroke="#aaa" stroke-width="1.8"/></g><text class="skill-text" x="${lbl.x}" y="${lbl.y}" text-anchor="${lbl.anchor}" style="font-size:${lbl.size}px;fill:#fff;">${lbl.text}</text></g>`);

        // DEBUG OVERLAY FOR SKILLS
        if (isDebug && s.sides < 30) {
            vts.forEach((v, i) => {
                svg.push(`<circle cx="${v.x}" cy="${v.y}" r="8" fill="#ffc107" opacity="0.9"/><text x="${v.x}" y="${v.y + 3}" font-size="10" fill="black" font-weight="bold" text-anchor="middle" pointer-events="none">${i}</text>`);
            });
        }
    });

    svg.push(
            `<script><![CDATA[
function handleClick(e){const id=e.getAttribute('data-skill-id'),n=e.getAttribute('data-name'),c=e.getAttribute('data-color')||'#58a6ff',lvl=e.getAttribute('data-level'),rar=e.getAttribute('data-rarity');if(e.id==='core-node'){document.querySelectorAll('.cat-node').forEach(el=>el.classList.replace('hidden-node','revealed-node'));document.querySelectorAll('.cat-line').forEach(el=>el.classList.replace('hidden-line','revealed-line'));return;}if(e.classList.contains('cat-node')){const cN=n;document.querySelectorAll('.skill').forEach(el=>{if(el.getAttribute('data-parents').split(',').includes(cN))el.classList.replace('hidden-node','revealed-node');});document.querySelectorAll('.skill-line-base[data-parent="'+cN+'"]').forEach(el=>el.classList.replace('hidden-line','revealed-line'));return;}if(e.classList.contains('skill')){if(e.classList.contains('locked')){e.classList.remove('locked');e.classList.add('unlocked','unlocked-anim');document.querySelectorAll('[data-link="'+id+'"]').forEach(p=>{p.style.stroke=c;p.style.strokeWidth='4.5';p.classList.add('energy');p.style.strokeOpacity='1';if(p.classList.contains('join-line'))p.classList.replace('hidden-line','revealed-line');});document.querySelectorAll('.join-line[data-source="'+id+'"], .join-label[data-source="'+id+'"]').forEach(p=>p.classList.replace('hidden-line','revealed-line'));}}}

const svgE = document.documentElement;
let isP = false, sPt = {x:0, y:0};
let vB = {x: ${vbX}, y: ${vbY}, w: ${vbW}, h: ${vbH}};
const defaultHbW = ${vbW}, defaultHbH = ${vbH};

svgE.addEventListener('mousedown', e => {
    isP = true; sPt = { x: e.clientX, y: e.clientY };
    svgE.style.cursor = "grabbing";
});
svgE.addEventListener('mousemove', e => {
    if(!isP) return;
    vB.x -= (e.clientX - sPt.x) * (vB.w / svgE.clientWidth);
    vB.y -= (e.clientY - sPt.y) * (vB.h / svgE.clientHeight);
    svgE.setAttribute('viewBox', vB.x+' '+vB.y+' '+vB.w+' '+vB.h);
    sPt = { x: e.clientX, y: e.clientY };
});
svgE.addEventListener('mouseup', () => { isP = false; svgE.style.cursor = "default"; });
svgE.addEventListener('mouseleave', () => { isP = false; });
svgE.addEventListener('wheel', e => {
    e.preventDefault();
    const zf = Math.exp((e.deltaY < 0 ? 1 : -1) * 0.1);
    const mx = vB.x + (e.clientX / svgE.clientWidth) * vB.w;
    const my = vB.y + (e.clientY / svgE.clientHeight) * vB.h;
    vB.w /= zf; vB.h /= zf;
    vB.x = mx - (vB.w * (e.clientX / svgE.clientWidth));
    vB.y = my - (vB.h * (e.clientY / svgE.clientHeight));
    svgE.setAttribute('viewBox', vB.x+' '+vB.y+' '+vB.w+' '+vB.h);
}, {passive: false});
]]></script>`
        );
    svg.push(`</svg>`);
    return svg.join("");
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, generateSVG(data));
console.log('Pinpoint Join Tree SVG generated successfully at', outputPath);