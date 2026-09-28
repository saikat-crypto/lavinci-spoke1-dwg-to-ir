# v4-dwg-to-ir: High-Performance CAD DWG to Semantic CAD IR Compiler

<div align="center">

[![TypeScript: 5.x](https://img.shields.io/badge/TypeScript-5.x-3178C6.svg?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![LibreDWG: 0.13.3](https://img.shields.io/badge/LibreDWG-0.13.3-orange.svg?style=for-the-badge)](https://www.gnu.org/software/libredwg/)
[![Architecture: Hub-and-Spoke](https://img.shields.io/badge/Architecture-Hub--and--Spoke%20v4-6C5CE7.svg?style=for-the-badge)](#)
[![Precision: IEEE-754 Float64](https://img.shields.io/badge/Precision-IEEE--754%20Float64-2ED573.svg?style=for-the-badge)](#)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg?style=for-the-badge)](#)

**High-performance, production-grade CAD DWG/DWT decompression and normalization engine. Converts proprietary AutoCAD binary files into a canonical, mathematically rigorous Semantic CAD Intermediate Representation (IR).**

*Part of the La Vinci CAD processing ecosystem (v4).*

</div>

---

## 🏛️ Architecture: The Hub-and-Spoke Model (v4)

In modern CAD systems, converting between $N$ distinct CAD/vector formats (DWG, DXF, SVG, PDF, WebGL) via ad-hoc point-to-point converters leads to an $O(N^2)$ translation nightmare with compounding floating-point drift, coordinate corruption, and lost entity semantics.

`v4-dwg-to-ir` serves as the **authoritative Inbound Spoke** that ingests binary DWG/DWT files and emits the **Canonical Semantic CAD IR (The Hub)**:

```
┌─────────────────────────────────┐
│     Binary AutoCAD DWG / DWT    │
└────────────────┬────────────────┘
                 │
                 ▼
┌────────────────────────────────────────────────────────┐
│  v4-dwg-to-ir (Inbound Engine)                         │
│  - Stage 0: LibreDWG C Streaming Extraction            │
│  - Stage 1: Symbol & Handle Indexing (O(1))            │
│  - Stage 2: Block Definition & Affine Transform Engine │
│  - Stage 3: Exact Geometry & Property Normalization    │
│  - Stage 4: Scene Graph Assembly & Audit Ledger        │
└────────────────┬───────────────────────────────────────┘
                 │
                 ▼
┌────────────────────────────────────────────────────────┐
│  CANONICAL SEMANTIC CAD IR (The Hub)                   │
│  Exact Analytic Geometry • Symbolic Properties         │
│  Instanced Scene Graph • Zero Unaccounted Entities     │
└───────┬────────────────┬────────────────┬──────────────┘
        │                │                │
        ▼                ▼                ▼
   v4-ir-to-svg     v4-ir-to-pdf     v4-ir-to-dxf   ... (Outbound Spokes)
```

---

## ⚡ Core Invariants & Engineering Guarantees

1. **Exact Analytic Geometry (No Premature Approximation):**
   * Circles remain exact circles (`center`, `radius`).
   * Arcs retain exact start and end angles.
   * Lightweight polylines (`LWPOLYLINE`) preserve exact mathematical bulge parameters ($b = \tan(\theta/4)$).
   * Splines retain exact NURBS knots, control points, and rational weights. Approximations (Béziers, tessellation) are deferred strictly to downstream render spokes.

2. **Instanced Scene Graph (No Coordinate Baking):**
   * Block definitions (`BLOCK_HEADER`) are indexed once in their local coordinate frames.
   * `INSERT` occurrences become `BlockInstance` nodes carrying full 2D affine transformation matrices (`AffineMatrix2D`).
   * Non-uniform scale ($S_x \neq S_y$) and negative scale (mirroring/winding flip) are detected and flagged lazily.

3. **Symbolic Property Inheritance:**
   * Properties are preserved symbolically (`ByLayer`, `ByBlock`, `ACI index`, or explicit 24-bit TrueColor).
   * Colors are never guessed prematurely — resolution occurs contextually at render time based on enclosing block occurrences and viewport layer overrides.

4. **Zero Silent Data Loss (`ProxyEntity` & Field Ledger):**
   * Civil 3D, Architectural, or third-party custom objects (`ACAD_PROXY_ENTITY`) are preserved as first-class `ProxyEntity` nodes retaining their proxy wireframe previews and binary payload hashes.
   * Every execution generates an audit ledger verifying `unaccounted == 0`.

---

## 📊 Real-World Engineering Benchmarks

Tested on real-world engineering blueprints across mechanical, civil, architectural, and electrical domains:

| Drawing Model | Category | Total Objects | Decode Time | Normalization Time | Total Pipeline Time | Normalized Elements | Unaccounted Entities |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`Engineering_EX1_Model.dwg`** | Mechanical Component | 308 | 111 ms | 10 ms | **121 ms** | 127 | **0** |
| **`Engineering_EX15_Model.dwg`** | Mechanical Assembly | 355 | 123 ms | 16 ms | **139 ms** | 152 | **0** |
| **`natural-lighting-guide.dwg`** | Architectural Lighting | 354 | 246 ms | 13 ms | **259 ms** | 112 | **0** |
| **`Building_Plan_2BHK.dwg`** | Residential Blueprint | 467 | 164 ms | 13 ms | **177 ms** | 312 | **0** |
| **`Villa_Plan_Final_Project.dwg`** | Multi-story Villa Architecture | 5,745 | 967 ms | 143 ms | **1,110 ms** | 4,979 | **0** |
| **`public-lighting.dwg`** | Heavy Luminaire Library | 30,142 | 3,748 ms | 492 ms | **4,240 ms** | 21,850 | **0** |

---

## 🚀 Programmatic Usage

Install as a dependency in your service:

```typescript
import { convertDwgToSemanticIR } from '@lavinci/v4-dwg-to-ir';

async function main() {
  const result = await convertDwgToSemanticIR('./sample_blueprint.dwg');

  console.log(`Units: ${result.ir.meta.linearUnitsLabel}`);
  console.log(`Extents:`, result.ir.meta.modelExtents);
  console.log(`Root ModelSpace Entities: ${result.ir.modelSpace.entities.length}`);
  console.log(`Block Definitions: ${result.ir.blockDefinitions.size}`);
  console.log(`Audit Unaccounted: ${result.ir.audit.fieldDispositions.unaccounted}`); // 0
}

main();
```

---

## 🛠️ CLI Regression Benchmark Tool

You can test any `.dwg` file on the command line:

```bash
# Run benchmark and print summary
npx tsx src/ir/semantic/testRunner.ts path/to/drawing.dwg

# Run benchmark and save canonical Semantic CAD IR JSON to disk
npx tsx src/ir/semantic/testRunner.ts path/to/drawing.dwg --save-json
```

---

## 🐳 Docker & AWS Production Deployment

`v4-dwg-to-ir` is architected for containerized deployment in AWS Lambda (container images) or AWS ECS Fargate:

```dockerfile
# Build container
docker build -t v4-dwg-to-ir .

# Run conversion inside container
docker run --rm -v $(pwd):/workspace v4-dwg-to-ir /workspace/drawing.dwg
```

---

## 📜 License

ISC © Saikat Dutta Chowdhury.
