import type { PipelineState } from '../app/pipeline';

export function createStatus(container: HTMLElement, onCancel: () => void) {
  const state = document.createElement('div'); state.className = 'state'; state.setAttribute('role', 'status');
  const notice = document.createElement('div'); notice.className = 'notice'; notice.hidden = true;
  notice.setAttribute('role', 'status'); container.append(state, notice);
  const button = (text: string, action: () => void) => {
    const b = document.createElement('button'); b.textContent = text; b.addEventListener('click', action); return b;
  };
  return {
    setState(s: PipelineState) {
      state.replaceChildren(); state.hidden = s.kind === 'idle';
      if (s.kind === 'busy') {
        const text = document.createElement('span');
        text.textContent = `${s.task === 'preview' ? 'Previewing' : s.task === 'generate' ? 'Generating terrain' : 'Exporting bundle'} · ${Math.round(s.progress * 100)}%`;
        const progress = document.createElement('progress'); progress.max = 1; progress.value = s.progress;
        progress.setAttribute('aria-label', text.textContent);
        state.append(text, progress, button('Cancel', onCancel));
      } else if (s.kind === 'error') {
        const text = document.createElement('span'); text.textContent = s.message; state.append(text, button('Retry', s.retry));
      }
    },
    notice(message: string) {
      const text = document.createElement('span'); text.textContent = message;
      const dismiss = button('×', () => { notice.hidden = true; }); dismiss.setAttribute('aria-label', 'Dismiss notice');
      notice.replaceChildren(text, dismiss); notice.hidden = false;
    },
  };
}
