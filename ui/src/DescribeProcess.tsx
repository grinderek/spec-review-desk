import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type InitiativeId, type InitiativesResponse } from './api.ts'
import { useAction } from './feedback.tsx'

export function DescribeProcess({ productName, choices, onCreated }: { productName?: string; choices: InitiativesResponse | undefined; onCreated: (id: InitiativeId) => void }) {
  const products = useQuery({ queryKey: ['products'], queryFn: api.products })
  const uid = useId(), act = useAction()
  const [selectedProduct, setProduct] = useState(productName ?? '')
  const [repo, setRepo] = useState('')
  const [selectedRepos, setRepos] = useState<string[] | null>(null)
  const [process, setProcess] = useState(''), [boundary, setBoundary] = useState('')
  const [name, setName] = useState(() => `process-${Date.now().toString(36)}`)
  const [where, setWhere] = useState<'new' | 'existing'>('new'), [worktree, setWorktree] = useState('')
  const [saving, setSaving] = useState(false)
  const product = products.data?.products.find(p => p.name === selectedProduct) ?? products.data?.products[0]
  const members = product?.components.filter(c => c.repo && c.availability === 'available') ?? []
  const anchor = members.find(c => c.repo === repo) ?? members.find(c => c.runner) ?? members[0]
  const sources = selectedRepos ?? members.filter(c => c.repo !== anchor?.repo || members.length === 1).map(c => c.repo!)
  const repoChoice = choices?.repos.find(r => r.name === anchor?.repo)
  const creations = useQuery({ queryKey: ['initiative-creations', anchor?.repo], queryFn: () => api.initiativeCreations(anchor!.repo!), enabled: !!anchor?.repo, refetchInterval: 3000 })
  const wt = repoChoice?.worktrees.find(w => w.id === worktree)
  const valid = product && anchor && process.trim() && boundary.trim() && sources.length && /^[a-z0-9][a-z0-9-]{1,40}$/.test(name) && (where === 'new' || wt)
  if (products.error) return <p className="banner bad">{products.error.message}</p>
  if (!products.data || !choices) return <p className="empty">Загружаем продукты...</p>
  if (!products.data.products.length) return <div className="head"><h1>Описать существующий процесс</h1><p>Сначала подключите продукт и его репозитории в конфигурации Desk.</p></div>
  const create = async () => {
    if (!valid || saving) return
    setSaving(true)
    await act(async () => {
      const form = new FormData()
      form.set('name', name); form.set('repo', anchor.repo!); form.set('where', where)
      form.set('base', choices.defaultBase); form.set('worktreeId', wt?.id ?? '')
      form.set('title', `Описание процесса: ${process.trim()}`)
      form.set('brief', `Продукт: ${product.title}\n\nПроцесс: ${process.trim()}\n\nГраницы исследования:\n${boundary.trim()}\n\nПодготовить предложение исполняемых правил по существующему коду. Обнаруженное поведение требует согласования владельцем.`)
      form.set('processProduct', product.name); form.set('processName', process.trim()); form.set('processBoundary', boundary.trim())
      for (const source of sources) form.append('processRepos', source)
      const result = await api.createInitiative(form)
      onCreated({ wt: result.worktreeId, name: result.name })
    }, 'Описание процесса создано. Запустите исследование кода.').finally(() => setSaving(false))
  }
  return <form className="head newfeature describe-process" onSubmit={e => { e.preventDefault(); void create() }}>
    <p className="eyebrow">Правила существующего продукта</p><h1>Описать существующий процесс</h1>
    <p>Выберите процесс. ИИ исследует код, предложит границы правил и подготовит карточки для вашего согласования.</p>
    {creations.data?.creations.filter(c => c.status !== 'completed').map(c => <section className="box" key={c.id}><strong>Создание {c.name}: {c.status}</strong><p>{c.reason}</p><button type="button" className="btn" onClick={() => void act(async () => { const result = await api.retryInitiativeCreation(anchor!.repo!, c.id); onCreated({ wt: result.worktreeId, name: result.name }) }, 'Создание продолжено')}>Продолжить создание</button><button type="button" className="btn" onClick={() => void act(() => api.recoverInitiativeCreations(anchor!.repo!))}>Проверить состояние</button></section>)}
    <label htmlFor={`${uid}-product`}>Продукт</label>
    <select id={`${uid}-product`} value={product?.name ?? ''} onChange={e => { setProduct(e.target.value); setRepo(''); setRepos(null); setWorktree('') }}>
      {products.data.products.map(p => <option key={p.name} value={p.name}>{p.title}</option>)}
    </select>
    <label htmlFor={`${uid}-process`}>Процесс</label><input id={`${uid}-process`} value={process} onChange={e => setProcess(e.target.value)} maxLength={200} placeholder="Например: настройка параметров техники" required />
    <label htmlFor={`${uid}-boundary`}>Начало, результат и границы процесса</label><textarea id={`${uid}-boundary`} value={boundary} onChange={e => setBoundary(e.target.value)} maxLength={4000} placeholder="С какого действия начинаем? Какой результат должен получить пользователь? Что пока не разбираем?" required />
    <label htmlFor={`${uid}-repo`}>Где хранить правила и согласование</label>
    <select id={`${uid}-repo`} value={anchor?.repo ?? ''} onChange={e => { setRepo(e.target.value); setRepos(null); setWorktree('') }}>{members.map(c => <option key={c.repo} value={c.repo}>{c.title} ({c.repo})</option>)}</select>
    <fieldset className="process-sources"><legend>Компоненты для исследования</legend>{members.map(c => <label key={c.repo}><input type="checkbox" checked={sources.includes(c.repo!)} onChange={e => setRepos(e.target.checked ? [...sources, c.repo!] : sources.filter(r => r !== c.repo))} /> {c.title}</label>)}</fieldset>
    <p className="rules-meta">Источник исследования: зафиксированная версия HEAD каждого выбранного репозитория. Файлы кода доступны ИИ для чтения; ссылки откроют сохраненный снимок.</p>
    {product?.components.filter(c => c.repo && c.availability !== 'available').map(c => <p className="errtext" key={c.name}>{c.title}: исходники недоступны, компонент не включен в исследование.</p>)}
    <details className="contract-details"><summary>Размещение исследования</summary>
      <label htmlFor={`${uid}-name`}>Короткое имя</label><input id={`${uid}-name`} value={name} onChange={e => setName(e.target.value)} />
      <label><input type="radio" checked={where === 'new'} onChange={() => setWhere('new')} /> Отдельная рабочая копия от {choices.defaultBase}</label>
      <label><input type="radio" checked={where === 'existing'} onChange={() => setWhere('existing')} /> Существующая рабочая копия</label>
      <select aria-label="Рабочая копия для описания" disabled={where !== 'existing'} value={worktree} onChange={e => setWorktree(e.target.value)}><option value="">Выберите рабочую копию</option>{repoChoice?.worktrees.map(w => <option key={w.id} value={w.id}>{w.branch ?? 'detached'} · {w.path}</option>)}</select>
    </details>
    <p>После создания: «Исследовать код» → согласовать границы → «Подготовить правила» → обсудить и согласовать карточки.</p>
    <button type="submit" className="btn pri" disabled={!valid || saving}>{saving ? 'Сохраняем снимок исходников...' : 'Создать описание процесса'}</button>
  </form>
}
