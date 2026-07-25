import type {
  GameSettings,
  AutoPathData,
  PathLine,
  SequenceItem,
  PathPoint,
  Vec2,
  Alliance,
} from '../types';
import { MAX_SAVED_AUTOS } from '../config';
import { StartPositionEditor } from './StartPositionEditor';
import { selectStart, switchCategory, saveStart, deleteSavedStart } from './startPositions';
import { ChainStartSelector } from './ChainStartSelector';

/**
 * Match configuration — the pre-game options that belong to the MATCH, not the
 * robot: alliance, start position, practice dummies, and an imported auto path.
 * These apply to the SOLO/offline modes (Solo Practice, Free Drive, Records);
 * Ranked and Custom assign alliance + start in the lobby / strategy screen.
 *
 * The MATCH section of `Configure`. It used to be a collapsed `<details>` on the
 * homepage; now it has a route of its own (`/configure/match`), so it renders
 * open. Kept separate from the robot loadout builder on purpose. `.pp` import +
 * the Pedro-Pathing → sim coordinate transform live here.
 */
export function MatchSetup({
  settings,
  onChange,
}: {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
}) {
  const set = (patch: Partial<GameSettings>) => onChange({ ...settings, ...patch });

  function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
  function showToast(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info') {
    alert(`${type.toUpperCase()}: ${message}`);
  }

  // --- Pedro Pathing (.pp) → sim coordinate transform ---
  const PP_FIELD_SIZE = 141.5;
  const PP_CENTER_OFFSET = PP_FIELD_SIZE / 2; // 70.75
  const SIM_FIELD_SIZE = 144; // From -72 to 72
  const SCALE_FACTOR = SIM_FIELD_SIZE / PP_FIELD_SIZE;

  function transformPpCoordinate(coord: Vec2): Vec2 {
    return {
      x: (coord.x - PP_CENTER_OFFSET) * SCALE_FACTOR,
      y: (coord.y - PP_CENTER_OFFSET) * SCALE_FACTOR,
    };
  }
  function transformPathPoint(pathPoint: PathPoint): PathPoint {
    const transformed = transformPpCoordinate(pathPoint);
    return { ...pathPoint, x: transformed.x, y: transformed.y };
  }

  function normalizeLines(input: PathLine[] = []): PathLine[] {
    return (input || []).map((line) => ({
      ...line,
      id: line.id || `line-${Math.random().toString(36).slice(2)}`,
      waitBeforeMs: Math.max(0, Number(line.waitBeforeMs ?? (line as any).waitBefore?.durationMs ?? 0)),
      waitAfterMs: Math.max(0, Number(line.waitAfterMs ?? (line as any).waitAfter?.durationMs ?? 0)),
      waitBeforeName: line.waitBeforeName ?? (line as any).waitBefore?.name ?? '',
      waitAfterName: line.waitAfterName ?? (line as any).waitAfter?.name ?? '',
      endPoint: transformPathPoint(line.endPoint),
      controlPoints: line.controlPoints?.map((cp) => transformPpCoordinate(cp)),
    }));
  }

  function deriveSequence(data: any, normalizedLines: PathLine[]): SequenceItem[] {
    if (Array.isArray(data?.sequence) && data.sequence.length) {
      return data.sequence as SequenceItem[];
    }
    return normalizedLines.map((ln) => ({ kind: 'path', lineId: ln.id! }));
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.pp')) {
      showToast('Please select a .pp file.', 'error');
      event.target.value = '';
      return;
    }
    if (settings.savedAutos.length >= MAX_SAVED_AUTOS) {
      showToast(`You can save up to ${MAX_SAVED_AUTOS} autos — delete one first.`, 'warning');
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const data = JSON.parse(content);
        if (!data.startPoint || !data.lines) {
          throw new Error('Invalid file format: missing required fields (startPoint or lines)');
        }
        const transformedStartPoint = transformPathPoint(data.startPoint);
        const normalizedLines = normalizeLines(data.lines || []);
        const autoPathData: AutoPathData = {
          fileName: file.name,
          startPoint: transformedStartPoint,
          lines: normalizedLines,
          shapes:
            data.shapes?.map((s: any) => ({
              ...s,
              points: s.points?.map((p: Vec2) => transformPpCoordinate(p)),
              x: s.x !== undefined ? transformPpCoordinate({ x: s.x, y: 0 }).x : undefined,
              y: s.y !== undefined ? transformPpCoordinate({ x: 0, y: s.y }).y : undefined,
            })) || [],
          sequence: deriveSequence(data, normalizedLines),
          version: data.version,
          timestamp: data.timestamp,
        };
        // add to the library AND select it as the active auto
        set({
          savedAutos: [...settings.savedAutos, autoPathData],
          autoPath: autoPathData,
          autoPathEnabled: true,
        });
        showToast(`Saved auto: ${file.name}`, 'success');
      } catch (error) {
        const errMsg = getErrorMessage(error);
        const message = errMsg.includes('Invalid file format')
          ? 'Invalid file format. This may not be a valid Pedro Pathing file.'
          : `Error loading file: ${errMsg}`;
        showToast(message, 'error');
      } finally {
        event.target.value = '';
      }
    };
    reader.onerror = () => {
      showToast(`Failed to read file: ${reader.error?.message}`, 'error');
      event.target.value = '';
    };
    reader.readAsText(file);
  };

  // select a saved auto as the active one (a copy stays in the library)
  const selectAuto = (a: AutoPathData) => set({ autoPath: a, autoPathEnabled: true });
  const deleteAuto = (i: number) => {
    const removed = settings.savedAutos[i];
    const savedAutos = settings.savedAutos.filter((_, j) => j !== i);
    const wasActive = !!removed && settings.autoPath?.fileName === removed.fileName;
    set(wasActive ? { savedAutos, autoPath: null, autoPathEnabled: false } : { savedAutos });
  };

  const setAlliance = (alliance: Alliance) => set({ alliance });
  // the start-position editor is built on DECODE's G304 legality + goal geometry —
  // hidden for the Chain Reaction shell (its start rules arrive with its manual).
  const isDecode = settings.game === 'decode';

  return (
    <section className="ds-panel">
      <div className="ds-panel-h">
        <span className="ds-panel-title">Match setup</span>
      </div>

      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <section className="ds-sec">
          <h2>Alliance</h2>
          <div className="ds-opts two">
            <button
              className={`ds-opt red ${settings.alliance === 'red' ? 'on' : ''}`}
              onClick={() => setAlliance('red')}
            >
              <span className="ot">RED</span>
            </button>
            <button
              className={`ds-opt blue ${settings.alliance === 'blue' ? 'on' : ''}`}
              onClick={() => setAlliance('blue')}
            >
              <span className="ot">BLUE</span>
            </button>
          </div>
        </section>

        <section className="ds-sec">
          <h2>Start position</h2>
          {isDecode ? (
            <StartPositionEditor
              spec={settings.spec}
              alliance={settings.alliance}
              value={settings.startPose}
              startIndex={settings.startIndex}
              category={settings.startCat}
              saved={settings.savedStartPoses}
              onChange={(startPose) => startPose && set(selectStart(settings, { index: -1, pose: startPose }))}
              onPickPreset={(i) => set(selectStart(settings, { index: i, pose: null }))}
              onCategory={(c) => set(switchCategory(settings, c))}
              onSave={(pose) => set(saveStart(settings, pose))}
              onDeleteSaved={(c, i) => set(deleteSavedStart(settings, c, i))}
            />
          ) : (
            <ChainStartSelector
              startIndex={settings.startIndex ?? 0}
              onPick={(i) => set({ startIndex: i, startPose: null })}
            />
          )}
          <div className="ds-opts" style={{ marginTop: 12 }}>
            <button
              className={`ds-opt mini ${settings.practiceDummies ? 'on' : ''}`}
              onClick={() => set({ practiceDummies: !settings.practiceDummies })}
            >
              <span className="ot">Practice dummies {settings.practiceDummies ? 'ON' : 'OFF'}</span>
            </button>
          </div>
        </section>

        <section className="ds-sec">
          <h2>
            Auto path{' '}
            <span className="ds-count">
              {settings.savedAutos.length}/{MAX_SAVED_AUTOS}
            </span>
          </h2>
          <div className="ds-opts">
            {settings.savedAutos.map((a, i) => {
              const active = settings.autoPath?.fileName === a.fileName;
              return (
                <div
                  key={i}
                  className={`ds-opt ${active ? 'on' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => selectAuto(a)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') selectAuto(a);
                  }}
                >
                  <button
                    className="ds-opt-del"
                    title="Delete this auto"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteAuto(i);
                    }}
                  >
                    ✕
                  </button>
                  <span className="ot">{a.fileName}</span>
                  <span className="od">
                    {a.lines?.length ?? 0} segments{active ? ' · selected' : ''}
                  </span>
                </div>
              );
            })}
            {settings.savedAutos.length < MAX_SAVED_AUTOS && (
              <label className="ds-opt ds-opt-add" style={{ cursor: 'pointer' }}>
                <span className="ot">＋ Import .pp</span>
                <input type="file" accept=".pp" onChange={handleFileChange} style={{ display: 'none' }} />
              </label>
            )}
          </div>
          {settings.autoPath && (
            <button
              className={`ds-opt ${settings.autoPathEnabled ? 'on' : ''}`}
              style={{ marginTop: 10 }}
              onClick={() => set({ autoPathEnabled: !settings.autoPathEnabled })}
            >
              <span className="ot">Auto path {settings.autoPathEnabled ? 'ON' : 'OFF'}</span>
              <span className="od">
                {settings.autoPathEnabled
                  ? `Running: ${settings.autoPath.fileName}`
                  : 'Selected auto is off'}
              </span>
            </button>
          )}
          <p className="ds-hint">
            Build a <code>.pp</code> path at{' '}
            <a
              href="https://visualizer.pedropathing.com"
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--ds-accent)' }}
            >
              visualizer.pedropathing.com
            </a>
            .
          </p>
        </section>
      </div>
    </section>
  );
}
