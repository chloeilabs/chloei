import { getTestMocks } from "./mock-state.mjs"

function createSqlText(strings, values) {
  return strings.reduce((text, segment, index) => {
    const placeholder = index < values.length ? `$${index + 1}` : ""
    return `${text}${segment}${placeholder}`
  }, "")
}

export function sql(strings, ...values) {
  const sqlCall = {
    strings: Array.from(strings),
    values,
    text: createSqlText(strings, values),
  }

  return {
    async execute(database) {
      return (
        (await getTestMocks().kysely?.execute?.({
          ...sqlCall,
          database,
        })) ?? { rows: [] }
      )
    },
  }
}
