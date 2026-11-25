import "./test_setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import { applySingleFrameEarlyTrim } from "../compositor/single_frame_trim.js";

const FPS = 30;

function run(entries: string[], timingEndIdx: number, k = 150, e = 152) {
  return applySingleFrameEarlyTrim({ entries, timingEndIdx, startFrame: k, endFrame: e, fps: FPS });
}

test("lands behind rotate and rewrites counters right of it", () => {
  const entries = [
    "settb=AVTB",
    "trim=start=0.000:end=4.000",
    "setpts=(PTS-STARTPTS)/1.0000",
    "fps=30:eof_action=pass",
    "tpad=stop_mode=clone:stop_duration=4.067",
    "scale=960:540:flags=lanczos:in_color_matrix=bt709:out_color_matrix=bt709",
    "format=yuv420p",
    "rotate=a='((0.5)*PI/180)':ow='rotw((0.5)*PI/180)':c=none",
    "perspective=x0='(W*(1-(abs(((in-1)/30))))/2':y0='0':x1='(W*(1+(abs(((in-1)/30))))/2':y1='0':x2='(W*(1-(abs(((in-1)/30))))/2':y2='H':x3='(W*(1+(abs(((in-1)/30))))/2':y3='H':sense=destination:interpolation=linear:eval=frame",
    "crop=w=iw-4:h=ih-4:x=2:y=2",
  ];
  const r = run(entries, 5, 150, 152);
  assert.equal(r.applied, true, r.reason);
  assert.equal(r.behindFilter, "rotate");
  assert.equal(r.entries[r.trimIndex], "trim=start_frame=150:end_frame=152");
  const after = r.entries.slice(r.trimIndex + 1).join(",");
  assert.match(after, /\(\(in-1\+150\)\/30\)/);
  assert.doesNotMatch(after, /\(\(in-1\)\/30\)/);
  const before = r.entries.slice(0, r.trimIndex).join(",");
  assert.ok(!before.includes("trim=start_frame"));
});

test("lands at the timing block end when everything is stateless", () => {
  const entries = [
    "fps=30:eof_action=pass",
    "tpad=stop_mode=clone:stop_duration=2.067",
    "scale=480:270",
    "format=rgba",
  ];
  const r = run(entries, 2, 90, 92);
  assert.equal(r.applied, true, r.reason);
  assert.equal(r.behindFilter, null);
  assert.equal(r.entries[2], "trim=start_frame=90:end_frame=92");
});

test("not applied with an unknown filter", () => {
  const entries = [
    "settb=AVTB",
    "trim=start=0:end=2",
    "setpts=(PTS-STARTPTS)/1.0000",
    "fps=30:eof_action=pass",
    "scale=480:270",
    "eq=brightness=0.1",
    "format=rgba",
  ];
  const r = run(entries, 4);
  assert.equal(r.applied, false);
  assert.match(r.reason, /eq/);
  assert.deepEqual(r.entries, entries);
});

test("not applied with a labelled entry", () => {
  const entries = [
    "settb=AVTB",
    "trim=start=0:end=2",
    "fps=30:eof_action=pass",
    "split[a][b];[a]format=rgba",
  ];
  const r = run(entries, 3);
  assert.equal(r.applied, false);
  assert.match(r.reason, /labelled/);
});

test("not applied when fps/tpad sit after the timing block", () => {
  const entries = [
    "settb=AVTB",
    "trim=start=0:end=2",
    "fps=30:eof_action=pass",
    "scale=480:270",
    "fps=30",
    "format=rgba",
  ];
  const r = run(entries, 3);
  assert.equal(r.applied, false);
  assert.match(r.reason, /fps/);
});

test("not applied when an expression uses a bare frame counter", () => {
  const entries = [
    "fps=30:eof_action=pass",
    "tpad=stop_mode=clone:stop_duration=2.067",
    "scale=480:270",
    "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip(alpha(X,Y)*(0.5+0.5*sin(n/10)),0,255)'",
  ];
  const r = run(entries, 2);
  assert.equal(r.applied, false);
  assert.match(r.reason, /geq/);
});

test("multi-filter entry splits correctly", () => {
  const entries = [
    "fps=30:eof_action=pass",
    "tpad=stop_mode=clone:stop_duration=2.067",
    "scale=in_color_matrix=bt709:out_color_matrix=bt709,format=rgba",
    "scale=480:270",
  ];
  const r = run(entries, 2, 10, 12);
  assert.equal(r.applied, true, r.reason);
  assert.equal(r.entries[r.trimIndex], "trim=start_frame=10:end_frame=12");
  assert.ok(r.entries.includes("format=rgba"));
  assert.ok(r.entries.includes("scale=in_color_matrix=bt709:out_color_matrix=bt709"));
});

test("chroma cutout entry splits and is rejected on colorkey", () => {
  const entries = [
    "fps=30:eof_action=pass",
    "tpad=stop_mode=clone:stop_duration=2.067",
    "format=rgba,colorkey=0x00FF00:0.30:0.20",
    "scale=480:270",
  ];
  const r = run(entries, 2, 10, 12);
  assert.equal(r.applied, false);
  assert.match(r.reason, /colorkey/);
});

test("counters left of the trim are not rewritten", () => {
  const entries = [
    "fps=30:eof_action=pass",
    "tpad=stop_mode=clone:stop_duration=2.067",
    "rotate=a='(((in-1)/30)*PI/180)':c=none",
    "scale=480:270",
  ];
  const r = run(entries, 2, 40, 42);
  assert.equal(r.applied, true, r.reason);
  assert.equal(r.behindFilter, "rotate");
  assert.match(r.entries.join(","), /\(\(in-1\)\/30\)/);
});

test("nothing is inserted before the timing block, end trim untouched", () => {
  const entries = [
    "settb=AVTB",
    "trim=start=0:end=2",
    "setpts=PTS-STARTPTS",
    "fps=30:eof_action=pass",
    "scale=480:270",
    "format=rgba",
  ];
  const r = run(entries, 4, 5, 7);
  assert.equal(r.applied, true, r.reason);
  assert.deepEqual(r.entries.slice(0, 4), entries.slice(0, 4));
});

test("T-based geq right of the trim is allowed", () => {
  const entries = [
    "fps=30:eof_action=pass",
    "tpad=stop_mode=clone:stop_duration=2.067",
    "rotate=a='(0.1*PI/180)':c=none",
    "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip(alpha(X,Y)*T,0,255)'",
  ];
  const r = run(entries, 2, 20, 22);
  assert.equal(r.applied, true, r.reason);
  assert.equal(r.behindFilter, "rotate");
});
