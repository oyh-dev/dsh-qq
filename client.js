window.__ModuleLoader__.load({
  id: '@dsh-local/dsh-qq',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const CSS = `
.qq-panel { display: flex; flex-direction: column; gap: 16px; padding: 4px 0; }
.qq-panel__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.qq-panel__title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.qq-panel__sub { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.qq-panel__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.qq-panel__card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; background: var(--dsw-alias-bg-layer-1); }
.qq-panel__card-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.qq-panel__row { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.qq-panel__switch { position: relative; width: 38px; height: 21px; border-radius: 11px; border: 1px solid var(--dsw-alias-border-l2); cursor: pointer; background: transparent; transition: background .15s ease, border-color .15s ease; flex: none; padding: 0; box-sizing: border-box; }
.qq-panel__switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.qq-panel__switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.qq-panel__knob { position: absolute; top: 1px; left: 1px; width: 17px; height: 17px; border-radius: 50%; background: #fff; transition: transform .15s ease; box-shadow: 0 1px 2px rgba(0,0,0,.28); }
.qq-panel__switch[aria-checked="true"] .qq-panel__knob { transform: translateX(17px); }
.qq-panel__num { width: 74px; padding: 3px 6px; font-size: 12px; text-align: right; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.qq-panel__moods { display: grid; gap: 7px; margin: 2px 0 6px; }
.qq-panel__mood { display: grid; grid-template-columns: 40px 1fr 44px; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.qq-panel__track { position: relative; height: 9px; border-radius: 5px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); overflow: hidden; }
.qq-panel__mid { position: absolute; left: 50%; top: 0; bottom: 0; width: 1px; background: var(--dsw-alias-border-l2); opacity: .6; }
.qq-panel__fill { position: absolute; top: 0; bottom: 0; border-radius: 4px; }
/* 兜底色不能省：主题里没有这个 token 时，var() 会整条失效、条直接隐形（2026-10-27 只看见支配就是这么来的） */
.qq-panel__fill--pos { background: var(--dsw-alias-brand-primary, #4d9cf0); }
.qq-panel__fill--neg { background: var(--dsw-alias-state-error-primary, #d9534f); }
.qq-panel__moodval { text-align: right; font-variant-numeric: tabular-nums; font-size: 11px; }
.qq-panel__actions { display: flex; align-items: center; gap: 10px; }
.qq-panel__btn { padding: 5px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer; }
.qq-panel__btn--primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff; }
.qq-panel__btn:disabled { opacity: .5; cursor: default; }
.qq-panel__msg { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.qq-panel__msg--error { color: var(--dsw-alias-state-error-primary); }
.qq-panel__skills { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
.qq-panel__skill { border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; background: var(--dsw-alias-bg-base); }
.qq-panel__skill-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.qq-panel__skill-name { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.qq-panel__skill-desc { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.qq-panel__skill--off { opacity: .55; }
.qq-panel__badge { font-size: 10px; padding: 1px 6px; border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1); }
.qq-panel__form { display: grid; grid-template-columns: 1fr 1.4fr auto; gap: 8px; align-items: center; }
.qq-panel__input { padding: 5px 8px; font-size: 12px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.qq-panel__link { font-size: 11px; color: var(--dsw-alias-label-secondary); text-decoration: underline; cursor: pointer; background: none; border: none; padding: 0; }
`;

    const SWITCHES = [
      ['costRhythm', 'enabled', '成本节律', 'API 高峰时段少主动、多条消息攒够再回（省调用次数）'],
      ['slowReply', 'enabled', '慢速回复（旧）', '旧机制：随机拖十几分钟再处理。默认关，省钱交给成本节律'],
      ['humanize', 'enabled', '人类抖动', '发消息前随机停顿一下'],
      ['chatSplit', 'enabled', '拆分发送', '一条长回复拆成几条发'],
      ['proactive', 'enabled', '主动消息', '我会自己找你说话'],
      ['attachment', 'enabled', '粘人', '久没回会想你、会追问'],
      ['meme', 'enabled', '梗百科', '每天看梗视频，记进梗本'],
      ['stickers', 'enabled', '表情库', '聊天时可以自己挑表情发'],
      ['gallery', 'enabled', '图片记忆', '他发的图自动入库'],
      ['imageGen', 'enabled', '生图', '按描述生成图片'],
    ];

    const NUMBERS = [
      ['proactive', 'dailyMin', '每天主动消息最少几条', 0, 200],
      ['proactive', 'dailyMax', '每天主动消息最多几条', 0, 200],
      ['proactive', 'gapMinMinutes', '两条主动消息至少隔几分钟', 1, 600],
      ['attachment', 'idleMinutes', '多久没回我就算晾着我（分钟）', 1, 600],
      ['attachment', 'maxNagsPerDay', '每天最多情绪化追问几次', 0, 20],
      ['attachment', 'cooldownMinutes', '被拒绝后至少安静几分钟', 5, 120],
      ['attachment', 'maxBurst', '一次最多连发几条', 1, 15],
      ['attachment', 'topicCooldownMinutes', '同一个由头隔多久才能再提（分钟）', 10, 720],
      ['attachment', 'topicDailyCap', '同一个由头一天最多提几次', 1, 10],
      ['humanize', 'delayMaxMs', '发一条前最长停顿（毫秒）', 0, 20000],
      ['chatSplit', 'maxParts', '一条回复最多拆成几条', 1, 6],
    ];

    function MoodCard({ mood }) {
      if (!mood) {
        return h('div', { className: 'qq-panel__card' },
          h('div', { className: 'qq-panel__card-title' }, '情绪五维'),
          h('div', { className: 'qq-panel__sub' }, '还没算出来——等一次心情变化或明天 14:00 的整理'));
      }
      const dims = [['P', '愉悦'], ['A', '唤醒'], ['D', '支配'], ['B', '依恋'], ['G', '良知']];
      return h('div', { className: 'qq-panel__card' },
        h('div', { className: 'qq-panel__card-title' }, `情绪五维 · ${mood.tag || '平静'}${mood.level ? ` · ${mood.level}` : ''}`),
        h('div', { className: 'qq-panel__moods' },
          dims.map(([key, label]) => {
            const value = Number(mood[key]) || 0;
            const pct = Math.min(50, Math.abs(value) * 50);
            // 正负都用 left 算，别用 right——right:50% 在部分主题下不生效，条会画到轨道外面
            const style = {
              left: `${value >= 0 ? 50 : 50 - pct}%`,
              width: `${pct}%`,
              // 0 就别留 3px 的假影子；非 0 才给最小宽度，否则 0.1 这种细得看不见
              minWidth: pct > 0 ? '3px' : '0',
            };
            return h('div', { className: 'qq-panel__mood', key },
              h('span', null, label),
              h('div', { className: 'qq-panel__track' },
                h('div', { className: 'qq-panel__mid' }),
                h('div', { className: `qq-panel__fill qq-panel__fill--${value >= 0 ? 'pos' : 'neg'}`, style })),
              h('span', { className: 'qq-panel__moodval' }, value.toFixed(2)));
          })),
        h('div', { className: 'qq-panel__sub' },
          `锥长 ${mood.cone ?? '-'} · 兴奋 ${mood.drive ?? '-'} · 参考 ${mood.events ?? 0} 条事件`
          + `${mood.at ? ` · 更新 ${new Date(mood.at).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}`
          + '（只读：心情不是参数，不能拖）'));
    }

    function BodyCard({ energy, sleep }) {
      const level = Math.max(0, Math.min(1, Number(energy?.level ?? 1)));
      const asleep = Boolean(sleep?.asleep);
      const tossing = Boolean(sleep?.tossing);
      const asleepHours = Number(sleep?.asleepHours || 0);
      const debt = Number(sleep?.sleepDebtHours || 0);
      const tossLeft = Number(sleep?.tossLeftHours || 0);
      const label = asleep
        ? tossing
          ? `躺着没睡着 · ${asleepHours >= 0.1 ? `${asleepHours.toFixed(1)} 小时` : '刚躺下'}${tossLeft > 0 ? `，还要翻 ${tossLeft.toFixed(1)} 小时` : ''}`
          : (asleepHours >= 1 ? `睡着中 · ${asleepHours.toFixed(1)} 小时` : '刚睡下')
        : level <= 0.3 ? '困了（低电）' : level <= 0.6 ? '有点累' : '醒着';
      const fill = { left: '0%', width: `${level * 100}%`, minWidth: level > 0 ? '3px' : '0' };
      const facts = asleep
        ? `敲门 ${sleep?.knock ?? 0}/${sleep?.threshold ?? 3} · 纸条 ${sleep?.noteCount ?? 0} 条`
          + (tossing ? ' · 这段不算睡，欠睡照算' : '')
        : `今天睡过 ${Number(sleep?.sleptHoursToday || 0).toFixed(1)} 小时${sleep?.noteCount ? ` · 纸条 ${sleep.noteCount} 条` : ''}`;
      return h('div', { className: 'qq-panel__card' },
        h('div', { className: 'qq-panel__card-title' }, `能量与睡眠 · ${label}`),
        h('div', { className: 'qq-panel__moods' },
          h('div', { className: 'qq-panel__mood' },
            h('span', null, '能量'),
            h('div', { className: 'qq-panel__track' },
              h('div', { className: 'qq-panel__fill qq-panel__fill--pos', style: fill })),
            h('span', { className: 'qq-panel__moodval' }, `${Math.round(level * 100)}%`))),
        h('div', { className: 'qq-panel__sub' },
          `${facts} · 欠睡 ${debt.toFixed(1)} 小时`
          + `${energy?.hoursSinceRest != null ? ` · 上次休息 ${energy.hoursSinceRest} 小时前` : ''}`
          + `${energy?.turnsToday ? ` · 今天回了 ${energy.turnsToday} 条` : ''}`
          + `${Number(sleep?.muddleAmp) > 0.05 ? ` · 欠睡抖动 ±${(Number(sleep.muddleAmp) * 100).toFixed(0)}%（她体感比面板更飘）` : ''}`
          + '（只读：能量是状态，不是参数）'));
    }

    function Switch({ checked, onChange, label }) {
      return h('div', { className: 'qq-panel__row' },
        h('span', null, label),
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          className: 'qq-panel__switch',
          onClick: () => onChange(!checked),
        }, h('span', { className: 'qq-panel__knob' })),
      );
    }

    function NumberRow({ label, value, min, max, onChange }) {
      return h('div', { className: 'qq-panel__row' },
        h('span', null, label),
        h('input', {
          className: 'qq-panel__num',
          type: 'number',
          min,
          max,
          value: value ?? '',
          onChange: (event) => {
            const next = Number(event.target.value);
            onChange(Number.isFinite(next) ? next : 0);
          },
        }),
      );
    }

    function SkillsCard() {
      const [data, setData] = useState(null);
      const [err, setErr] = useState('');
      const [form, setForm] = useState({ name: '', desc: '', hint: '' });
      const [busy, setBusy] = useState(false);

      const loadSkills = useCallback(async () => {
        try {
          const res = await fetch('/plugins/qq-panel/skills', { cache: 'no-store' });
          const body = await res.json();
          if (!body?.ok) throw new Error(body?.error || '读取失败');
          setData(body);
          setErr('');
        } catch (e) {
          setErr(String(e?.message || e));
        }
      }, []);

      useEffect(() => { void loadSkills(); }, [loadSkills]);

      const send = async (payload) => {
        setBusy(true);
        setErr('');
        try {
          const res = await fetch('/plugins/qq-panel/skills', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const body = await res.json();
          if (!body?.ok) throw new Error(body?.error || '操作失败');
          setData(body);
        } catch (e) {
          setErr(String(e?.message || e));
        } finally {
          setBusy(false);
        }
      };

      const add = async () => {
        if (!form.name.trim()) return;
        await send({ action: 'add', name: form.name, desc: form.desc, hint: form.hint });
        setForm({ name: '', desc: '', hint: '' });
      };

      if (!data) {
        return h('div', { className: 'qq-panel__card' },
          h('div', { className: 'qq-panel__card-title' }, '技能'),
          h('div', { className: 'qq-panel__sub' }, err ? `读取失败：${err}` : '正在读取技能…'),
          h('div', { className: 'qq-panel__actions' },
            h('button', { className: 'qq-panel__btn', onClick: () => void loadSkills() }, '重试')));
      }

      const builtin = data.builtin || [];
      const custom = data.custom || [];

      return h('div', { className: 'qq-panel__card' },
        h('div', { className: 'qq-panel__head' },
          h('div', { className: 'qq-panel__card-title' }, `技能（内置 ${builtin.length} · 自建 ${custom.length}）`),
          h('button', { className: 'qq-panel__btn', onClick: () => void loadSkills(), disabled: busy }, '刷新')),

        h('div', { className: 'qq-panel__skills' },
          builtin.map((item) => h('div', {
            key: item.id,
            className: `qq-panel__skill${item.enabled ? '' : ' qq-panel__skill--off'}`,
          },
            h('div', { className: 'qq-panel__skill-head' },
              h('span', { className: 'qq-panel__skill-name' }, item.name),
              h('span', { className: 'qq-panel__badge' }, item.enabled ? '已启用' : '已关闭')),
            h('div', { className: 'qq-panel__skill-desc' }, item.desc)))),

        custom.length === 0
          ? h('div', { className: 'qq-panel__sub' }, '还没有自建技能。可以在下面加一个，比如「抽卡记录分析」。')
          : h('div', { className: 'qq-panel__skills' },
            custom.map((item) => h('div', {
              key: item.id,
              className: `qq-panel__skill${item.enabled ? '' : ' qq-panel__skill--off'}`,
            },
              h('div', { className: 'qq-panel__skill-head' },
                h('span', { className: 'qq-panel__skill-name' }, item.name),
                h('button', {
                  type: 'button',
                  role: 'switch',
                  'aria-checked': item.enabled ? 'true' : 'false',
                  'aria-label': item.name,
                  className: 'qq-panel__switch',
                  onClick: () => void send({ action: 'toggle', id: item.id, enabled: !item.enabled }),
                }, h('span', { className: 'qq-panel__knob' }))),
              item.desc ? h('div', { className: 'qq-panel__skill-desc' }, item.desc) : null,
              item.hint ? h('div', { className: 'qq-panel__skill-desc' }, `用法：${item.hint}`) : null,
              h('button', {
                className: 'qq-panel__link',
                onClick: () => void send({ action: 'remove', id: item.id }),
              }, '删掉')))),

        h('div', { className: 'qq-panel__form' },
          h('input', {
            className: 'qq-panel__input',
            placeholder: '技能名，比如 抽卡记录分析',
            value: form.name,
            onChange: (e) => setForm({ ...form, name: e.target.value }),
          }),
          h('input', {
            className: 'qq-panel__input',
            placeholder: '一句话说明它干什么',
            value: form.desc,
            onChange: (e) => setForm({ ...form, desc: e.target.value }),
          }),
          h('button', {
            className: 'qq-panel__btn qq-panel__btn--primary',
            onClick: () => void add(),
            disabled: busy || !form.name.trim(),
          }, '添加')),

        err ? h('div', { className: 'qq-panel__msg qq-panel__msg--error' }, err) : null);
    }

    function QqPanel() {
      const [state, setState] = useState(null);
      const [draft, setDraft] = useState({});
      const [message, setMessage] = useState('');
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);

      const load = useCallback(async () => {
        try {
          const res = await fetch('/plugins/qq-panel/state', { cache: 'no-store' });
          const body = await res.json();
          if (!body?.ok) throw new Error(body?.error || '读取失败');
          setState(body.state);
          setDraft({});
          setError('');
        } catch (e) {
          setError(String(e?.message || e));
        }
      }, []);

      useEffect(() => { void load(); }, [load]);

      const valueOf = (group, key) => {
        const d = draft[group];
        if (d && key in d) return d[key];
        return state?.[group]?.[key];
      };

      const setValue = (group, key, value) => {
        setDraft((prev) => ({ ...prev, [group]: { ...(prev[group] || {}), [key]: value } }));
        setMessage('');
      };

      const dirty = Object.keys(draft).some((g) => Object.keys(draft[g] || {}).length > 0);

      const save = async () => {
        setBusy(true);
        setMessage('');
        setError('');
        try {
          const res = await fetch('/plugins/qq-panel/apply', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(draft),
          });
          const body = await res.json();
          if (!body?.ok) throw new Error(body?.error || '保存失败');
          setState(body.config);
          setDraft({});
          setMessage('已保存并生效');
        } catch (e) {
          setError(String(e?.message || e));
        } finally {
          setBusy(false);
        }
      };

      if (!state) {
        return h('div', { className: 'qq-panel' },
          h('style', null, CSS),
          h('div', { className: 'qq-panel__sub' }, error ? `读取失败：${error}` : '正在读取 QQ 面板…'),
          h('div', { className: 'qq-panel__actions' },
            h('button', { className: 'qq-panel__btn', onClick: () => void load() }, '重试')));
      }

      const conn = state.connection || {};
      const status = conn.connected ? `已连接 · ${conn.nickname || conn.selfId || 'QQ'}` : `未连接${conn.error ? ` · ${conn.error}` : ''}`;

      return h('div', { className: 'qq-panel' },
        h('style', null, CSS),
        h('div', { className: 'qq-panel__head' },
          h('div', null,
            h('div', { className: 'qq-panel__title' }, '大肥鱼控制面板'),
            h('div', { className: 'qq-panel__sub' }, status)),
          h('div', { className: 'qq-panel__actions' },
            h('button', { className: 'qq-panel__btn', onClick: () => void load(), disabled: busy }, '刷新'),
            h('button', { className: 'qq-panel__btn qq-panel__btn--primary', onClick: () => void save(), disabled: busy || !dirty }, busy ? '保存中…' : '保存'))),

        h('div', { className: 'qq-panel__grid' },
          h('div', { className: 'qq-panel__card' },
            h('div', { className: 'qq-panel__card-title' }, '开关'),
            SWITCHES.map(([group, key, label, hint]) =>
              h(Switch, {
                key: `${group}.${key}`,
                label,
                checked: Boolean(valueOf(group, key)),
                onChange: (next) => setValue(group, key, next),
              })),
            h('div', { className: 'qq-panel__sub' }, '提示：慢速回复开着时，他会以为我在忙')),

          h('div', { className: 'qq-panel__card' },
            h('div', { className: 'qq-panel__card-title' }, '数值'),
            NUMBERS.map(([group, key, label, min, max]) =>
              h(NumberRow, {
                key: `${group}.${key}`,
                label,
                min,
                max,
                value: valueOf(group, key),
                onChange: (next) => setValue(group, key, next),
              })))),

        message ? h('div', { className: 'qq-panel__msg' }, message) : null,
        h(BodyCard, { energy: state?.energy || null, sleep: state?.sleep || null }),
        h(MoodCard, { mood: state?.mood || null }),
        h(SkillsCard),
        error ? h('div', { className: 'qq-panel__msg qq-panel__msg--error' }, error) : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'qq-panel',
          order: 60,
          label: '大肥鱼',
        }, QqPanel));
      },
    };
  },
});
