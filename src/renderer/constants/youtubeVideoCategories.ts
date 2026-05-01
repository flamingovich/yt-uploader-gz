/** ID категории видео YouTube (`snippet.categoryId`); те же значения используются в метаданных эфира. */

const RAW: { id: string; label: string }[] = [
  { id: '1', label: 'Фильмы и анимация' },
  { id: '2', label: 'Авто и транспорт' },
  { id: '10', label: 'Музыка' },
  { id: '15', label: 'Питомцы и животные' },
  { id: '17', label: 'Спорт' },
  { id: '19', label: 'Путешествия и события' },
  { id: '20', label: 'Игры' },
  { id: '22', label: 'Люди и блоги' },
  { id: '23', label: 'Юмор' },
  { id: '24', label: 'Развлечения' },
  { id: '25', label: 'Новости и политика' },
  { id: '26', label: 'Хобби и стиль' },
  { id: '27', label: 'Образование' },
  { id: '28', label: 'Наука и технологии' },
  { id: '29', label: 'Некоммерческие и активизм' }
]

export const YOUTUBE_VIDEO_CATEGORY_OPTIONS: readonly { id: string; label: string }[] = [...RAW].sort((a, b) =>
  a.label.localeCompare(b.label, 'ru')
)

export function isKnownYoutubeVideoCategoryId(id: string): boolean {
  return RAW.some((o) => o.id === id)
}
