import { convertDwgToJson } from './dwgParser.js';

async function run() {
  const fileToTest = process.argv[2];
  if (!fileToTest) {
    console.error("Usage: npx tsx src/index.ts <path-to-dwg-file>");
    process.exit(1);
  }

  console.log(`Starting conversion for: ${fileToTest}`);
  try {
    const result = await convertDwgToJson(fileToTest);
    
    console.log(`\n✅ Conversion successful! Took ${result.durationMs} ms`);
    console.log(`Parsed Objects Count: ${result.json?.OBJECTS?.length || 0}`);
    
    const unknownEntities = (result.json?.OBJECTS || []).filter(
      (obj: any) => obj.type === 'UNKNOWN_ENT' || obj.type === 'UNKNOWN_OBJ'
    );
    
    console.log(`Unknown / Proxy Entities: ${unknownEntities.length}`);
    
    if (result.warnings.length > 0) {
      console.log(`\n⚠️ Warnings (${result.warnings.length}):`);
      result.warnings.slice(0, 5).forEach((w: string) => console.log(`  - ${w}`));
      if (result.warnings.length > 5) {
        console.log(`  ... and ${result.warnings.length - 5} more.`);
      }
    }
  } catch (err: any) {
    console.error(`\n❌ Error: ${err.message}`);
  }
}

run();
