export function setSrcObject(el: HTMLMediaElement | null, stream: MediaStream | null): void { if (el) el.srcObject = stream; }
