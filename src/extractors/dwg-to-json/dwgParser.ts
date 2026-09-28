import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface DwgConversionResult {
  json: any;
  warnings: string[];
  durationMs: number;
}

/**
 * Converts a DWG file to JSON using LibreDWG's dwgread CLI.
 * 
 * @param inputPath - Absolute path to the uploaded DWG file
 * @returns A promise that resolves to the parsed JSON and any warnings
 */
export async function convertDwgToJson(inputPath: string): Promise<DwgConversionResult> {
  const startTime = Date.now();
  
  // We use a temporary file for the JSON output because LibreDWG JSON dumps
  // can be massive (hundreds of MBs) and reading them via stdout buffer can crash.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dwg-convert-'));
  const outputPath = path.join(tempDir, 'output.json');

  return new Promise((resolve, reject) => {
    const dwgreadExe = path.join(process.cwd(), 'libredwg', 'dwgread.exe');
    // dwgread <input> -O JSON -o <output>
    const child = spawn(dwgreadExe, [inputPath, '-O', 'JSON', '-o', outputPath]);

    const warnings: string[] = [];

    child.stderr.on('data', (data) => {
      const msg = data.toString();
      // Collect warnings about proxy entities or unhandled classes
      if (msg.includes('WARNING') || msg.includes('Unhandled') || msg.includes('failed')) {
        warnings.push(msg.trim());
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to start dwgread. Is LibreDWG installed and in PATH? ${err.message}`));
    });

    child.on('close', async (code) => {
      if (code !== 0) {
        // We still check if output was partially generated
        try {
          await fs.access(outputPath);
        } catch {
          reject(new Error(`dwgread exited with code ${code}. No JSON file was generated.`));
          return;
        }
      }

      try {
        // Read and parse the massive JSON file
        const jsonContent = await fs.readFile(outputPath, 'utf8');
        const parsedJson = JSON.parse(jsonContent);

        // Clean up temp file
        await fs.rm(tempDir, { recursive: true, force: true });

        resolve({
          json: parsedJson,
          warnings,
          durationMs: Date.now() - startTime
        });
      } catch (err: any) {
        reject(new Error(`Failed to read or parse the JSON output: ${err.message}`));
      }
    });
  });
}
