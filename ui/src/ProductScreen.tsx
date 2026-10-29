import { useQuery } from '@tanstack/react-query'
import { api } from './api.ts'
import type { Selection } from './selection.ts'

export function ProductScreen({ name, onSelect }: { name: string; onSelect: (s: Selection) => void }) {
  const query = useQuery({ queryKey: ['products'], queryFn: api.products, refetchInterval: 30_000 })
  if (query.isLoading) return <p className="empty">Загружаем состав продукта...</p>
  if (query.error) return <p className="banner bad">{query.error.message}</p>
  const product = query.data?.products.find(p => p.name === name)
  if (!product) return <p className="empty">Продукт не найден в конфигурации Desk.</p>
  const repositories = product.components.filter(c => c.kind === 'repository')
  return <>
    <header className="head rules-head">
      <p className="eyebrow">Подключение продукта</p>
      <h1>{product.title}</h1>
      <p>{product.description}</p>
      <p className="rules-meta">{repositories.length} репозиториев · {product.components.length - repositories.length} вспомогательных папок · {product.components.filter(c => c.availability === 'unavailable').length} недоступных компонентов</p>
      <button className="btn" onClick={() => void query.refetch()} disabled={query.isFetching}>Обновить обзор</button>
      <button className="btn pri" onClick={() => onSelect({ kind: 'describe', product: name })}>Описать существующий процесс</button>
    </header>
    <div className="tabpanel product-overview">
      <section className="product-next">
        <h2>Процессы для проверки</h2>
        <p>Выберите один пользовательский процесс, который проходит через нужные компоненты. Разработчик подтверждает точки входа и способ проверки; ИИ готовит проект правил и адаптеры; владелец согласует ожидаемое поведение.</p>
        <p className="rules-meta">Этот обзор показывает доступность исходников, правил и настройки запуска. Откройте правила, чтобы увидеть результат проверки. Результаты проверки и согласования владельцем учитываются отдельно.</p>
      </section>
      {product.components.map(component => <article className="rule-card product-component" key={component.name}>
        <header><h2>{component.title}</h2><span className={`pill${component.availability === 'unavailable' ? ' r-failed' : ''}`}>{component.availability === 'unavailable' ? 'Компонент недоступен' : component.kind === 'directory' ? 'Папка доступна' : 'Репозиторий доступен'}</span></header>
        <p>{component.role}</p>
        {component.problem ? <p className="errtext">{component.problem}</p> : null}
        {component.source ? <p className="rules-meta">Ветка: {component.source.branch ?? 'detached HEAD'} · {component.source.changedFiles} локальных изменений · {component.source.worktrees} рабочих директорий</p> : null}
        {component.kind === 'repository' && component.availability === 'available' ? <div className="product-checks">
          <p><strong>Исполняемые правила:</strong> {component.rules?.count ? `${component.rules.count} правил` : 'пока не подключены'}</p>
          <p><strong>Запуск проверки:</strong> {component.runner ? `настроен (${component.runner.name})` : 'не настроен'}</p>
          {component.rules?.errors.map(error => <p className="errtext" key={error.file}>{error.file}: {error.message}</p>)}
          {component.rules?.count && component.worktreeId ? <button className="btn" onClick={() => onSelect({ kind: 'rules', wt: component.worktreeId! })}>Открыть правила</button> : null}
        </div> : null}
        <details className="contract-details"><summary>Подробности компонента</summary><p><code>{component.path}</code></p>{component.source ? <p>Ревизия: <code>{component.source.head}</code></p> : null}<p>{component.kind === 'repository' ? `Репозиторий: ${component.repo}` : 'Вспомогательная папка'}</p></details>
      </article>)}
    </div>
  </>
}
