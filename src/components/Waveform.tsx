import { useEffect, useRef } from 'react';

export function Waveform({ analyser, color, active }: { analyser?: AnalyserNode; color: string; active: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current!;
    const drawing = element.getContext('2d')!;
    const data = new Uint8Array(analyser?.fftSize ?? 256);
    const history = new Array<number>(100).fill(0);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    let last = 0;
    const render = (time: number) => {
      frame = requestAnimationFrame(render);
      if (time - last < (reduced ? 250 : 40)) return;
      last = time;
      const ratio = devicePixelRatio || 1;
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (element.width !== width * ratio || element.height !== height * ratio) { element.width = width * ratio; element.height = height * ratio; }
      drawing.setTransform(ratio, 0, 0, ratio, 0, 0);
      drawing.clearRect(0, 0, width, height);
      let volume = 0;
      if (analyser && active) {
        analyser.getByteTimeDomainData(data);
        volume = Math.sqrt(data.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / data.length);
      }
      history.shift(); history.push(volume);
      drawing.strokeStyle = color;
      drawing.globalAlpha = 0.16;
      drawing.lineWidth = 1;
      drawing.beginPath(); drawing.moveTo(0, height / 2); drawing.lineTo(width, height / 2); drawing.stroke();
      history.forEach((value, index) => {
        const barHeight = Math.max(2, Math.min(height - 10, value * height * 3));
        drawing.globalAlpha = value > 0.008 ? 0.8 : 0.18;
        drawing.fillStyle = color;
        drawing.beginPath();
        drawing.roundRect(index * width / history.length, (height - barHeight) / 2, Math.max(2, width / history.length - 3), barHeight, 2);
        drawing.fill();
      });
      drawing.globalAlpha = 1;
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [analyser, color, active]);
  return <canvas ref={canvas} className="wave-canvas" aria-label={active ? '实时音量波形' : '音轨等待连接'} role="img" />;
}
