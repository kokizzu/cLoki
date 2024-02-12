const messages = require('./querier_pb')
const types = require('./types/v1/types_pb')
const services = require('./querier_grpc_pb')
const clickhouse = require('../lib/db/clickhouse')
const { DATABASE_NAME } = require('../lib/utils')
const Sql = require('@cloki/clickhouse-sql')
const compiler = require('../parser/bnf')
const { readULeb32 } = require('./pprof')
const pprofBin = require('./pprof-bin/pkg/pprof_bin')
const { QrynBadRequest } = require('../lib/handlers/errors')
const { clusterName } = require('../common')

const HISTORY_TIMESPAN = 1000 * 60 * 60 * 24 * 7

/**
 *
 * @param typeId {string}
 */
const parseTypeId = (typeId) => {
  const typeParts = typeId.match(/^([^:]+):([^:]+):([^:]+):([^:]+):([^:]+)$/)
  if (!typeParts) {
    throw new QrynBadRequest('invalid type id')
  }
  return {
    type: typeParts[1],
    sampleType: typeParts[2],
    sampleUnit: typeParts[3],
    periodType: typeParts[4],
    periodUnit: typeParts[5]
  }
}

const profileTypesHandler = async (req, res) => {
  const dist = clusterName ? '_dist' : ''
  const _res = new messages.ProfileTypesResponse()
  const fromTimeSec = req.body && req.body.getStart
    ? parseInt(req.body.getStart()) / 1000
    : (Date.now() - HISTORY_TIMESPAN) / 1000
  const toTimeSec = req.body && req.body.getEnd
    ? parseInt(req.body.getEnd()) / 1000
    : Date.now() / 1000
  const profileTypes = await clickhouse.rawRequest(`SELECT DISTINCT type_id, sample_type_unit 
FROM profiles_series${dist} ARRAY JOIN sample_types_units as sample_type_unit
WHERE date >= toDate(FROM_UNIXTIME(${Math.floor(fromTimeSec)})) AND date <= toDate(FROM_UNIXTIME(${Math.floor(toTimeSec)})) FORMAT JSON`,
  null, DATABASE_NAME())
  _res.setProfileTypesList(profileTypes.data.data.map(profileType => {
    const pt = new types.ProfileType()
    const [name, periodType, periodUnit] = profileType.type_id.split(':')
    const typeIdParts = profileType.type_id.match(/^([^:]+):(.*)$/)
    pt.setId(typeIdParts[1] + ':' + profileType.sample_type_unit[0] + ':' + profileType.sample_type_unit[1] +
      ':' + typeIdParts[2])
    pt.setName(name)
    pt.setSampleType(profileType.sample_type_unit[0])
    pt.setSampleUnit(profileType.sample_type_unit[1])
    pt.setPeriodType(periodType)
    pt.setPeriodUnit(periodUnit)
    return pt
  }))
  return res.code(200).send(Buffer.from(_res.serializeBinary()))
}

const labelNames = async (req, res) => {
  const dist = clusterName ? '_dist' : ''
  const fromTimeSec = req.body && req.body.getStart
    ? parseInt(req.body.getStart()) / 1000
    : (Date.now() - HISTORY_TIMESPAN) / 1000
  const toTimeSec = req.body && req.body.getEnd
    ? parseInt(req.body.getEnd()) / 1000
    : Date.now() / 1000
  const labelNames = await clickhouse.rawRequest(`SELECT DISTINCT key 
FROM profiles_series_keys${dist}
WHERE date >= toDate(FROM_UNIXTIME(${Math.floor(fromTimeSec)})) AND date <= toDate(FROM_UNIXTIME(${Math.floor(toTimeSec)})) FORMAT JSON`,
  null, DATABASE_NAME())
  const resp = new types.LabelNamesResponse()
  resp.setNamesList(labelNames.data.data.map(label => label.key))
  return res.code(200).send(Buffer.from(resp.serializeBinary()))
}

const labelValues = async (req, res) => {
  const dist = clusterName ? '_dist' : ''
  const name = req.body && req.body.getName
    ? req.body.getName()
    : ''
  const fromTimeSec = req.body && req.body.getStart && req.body.getStart()
    ? parseInt(req.body.getStart()) / 1000
    : (Date.now() - HISTORY_TIMESPAN) / 1000
  const toTimeSec = req.body && req.body.getEnd && req.body.getEnd()
    ? parseInt(req.body.getEnd()) / 1000
    : Date.now() / 1000
  if (!name) {
    throw new Error('No name provided')
  }
  const labelValues = await clickhouse.rawRequest(`SELECT DISTINCT val
FROM profiles_series_gin${dist}
WHERE key = ${Sql.quoteVal(name)} AND 
date >= toDate(FROM_UNIXTIME(${Math.floor(fromTimeSec)})) AND 
date <= toDate(FROM_UNIXTIME(${Math.floor(toTimeSec)})) FORMAT JSON`, null, DATABASE_NAME())
  const resp = new types.LabelValuesResponse()
  resp.setNamesList(labelValues.data.data.map(label => label.val))
  return res.code(200).send(Buffer.from(resp.serializeBinary()))
}

const parser = (MsgClass) => {
  return async (req, payload) => {
    const _body = []
    payload.on('data', data => {
      _body.push(data)// += data.toString()
    })
    if (payload.isPaused && payload.isPaused()) {
      payload.resume()
    }
    await new Promise(resolve => {
      payload.on('end', resolve)
      payload.on('close', resolve)
    })
    const body = Buffer.concat(_body)
    if (body.length === 0) {
      return null
    }
    req._rawBody = body
    return MsgClass.deserializeBinary(body)
  }
}

let ctxIdx = 0

/**
 *
 * @param {Sql.Select} query
 * @param {string} labelSelector
 */
const labelSelectorQuery = (query, labelSelector) => {
  if (!labelSelector || !labelSelector.length || labelSelector === '{}') {
    return query
  }
  const labelSelectorScript = compiler.ParseScript(labelSelector).rootToken
  const labelsConds = []
  for (const rule of labelSelectorScript.Children('log_stream_selector_rule')) {
    const val = JSON.parse(rule.Child('quoted_str').value)
    let valRul = null
    switch (rule.Child('operator').value) {
      case '=':
        valRul = Sql.Eq(new Sql.Raw('val'), Sql.val(val))
        break
      case '!=':
        valRul = Sql.Ne(new Sql.Raw('val'), Sql.val(val))
        break
      case '=~':
        valRul = Sql.Eq(new Sql.Raw(`match(val, ${Sql.quoteVal(val)})`), 1)
        break
      case '!~':
        valRul = Sql.Ne(new Sql.Raw(`match(val, ${Sql.quoteVal(val)})`), 1)
    }
    const labelSubCond = Sql.And(
      Sql.Eq('key', Sql.val(rule.Child('label').value)),
      valRul
    )
    labelsConds.push(labelSubCond)
  }
  query.where(Sql.Or(...labelsConds))
  query.groupBy(new Sql.Raw('fingerprint'))
  query.having(Sql.Eq(
    new Sql.Raw(`groupBitOr(${labelsConds.map((cond, i) => {
      return `bitShiftLeft(toUInt64(${cond}), ${i})`
    }).join('+')})`),
    new Sql.Raw(`bitShiftLeft(toUInt64(1), ${labelsConds.length})-1`)
  ))
}

const selectMergeStacktraces = async (req, res) => {
  return await selectMergeStacktracesV2(req, res)
  const dist = clusterName ? '_dist' : ''
  const typeRegex = parseTypeId(req.body.getProfileTypeid())
  const sel = req.body.getLabelSelector()
  const fromTimeSec = req.body && req.body.getStart()
    ? Math.floor(parseInt(req.body.getStart()) / 1000)
    : Math.floor((Date.now() - 1000 * 60 * 60 * 48) / 1000)
  const toTimeSec = req.body && req.body.getEnd()
    ? Math.floor(parseInt(req.body.getEnd()) / 1000)
    : Math.floor(Date.now() / 1000)
  const idxSelect = (new Sql.Select())
    .select('fingerprint')
    .from(`${DATABASE_NAME()}.profiles_series_gin`)
    .where(
      Sql.And(
        Sql.Eq(new Sql.Raw(`has(sample_types_units, (${Sql.quoteVal(typeRegex.sampleType)},${Sql.quoteVal(typeRegex.sampleUnit)}))`), 1),
        Sql.Eq('type_id', Sql.val(`${typeRegex.type}:${typeRegex.periodType}:${typeRegex.periodUnit}`)),
        Sql.Gte('date', new Sql.Raw(`toDate(FROM_UNIXTIME(${Math.floor(fromTimeSec)}))`)),
        Sql.Lte('date', new Sql.Raw(`toDate(FROM_UNIXTIME(${Math.floor(toTimeSec)}))`))
      )
    ).groupBy('fingerprint')
  labelSelectorQuery(idxSelect, sel)
  const sqlReq = (new Sql.Select())
    .select('payload')
    .from(`${DATABASE_NAME()}.profiles${dist}`)
    .where(
      Sql.And(
        Sql.Gte('timestamp_ns', new Sql.Raw(Math.floor(fromTimeSec) + '000000000')),
        Sql.Lte('timestamp_ns', new Sql.Raw(Math.floor(toTimeSec) + '000000000')),
        new Sql.In('fingerprint', 'IN', idxSelect)
      ))
  if (process.env.ADVANCED_PROFILES_MERGE_LIMIT) {
    sqlReq.orderBy(['timestamp_ns', 'desc']).limit(parseInt(process.env.ADVANCED_PROFILES_MERGE_LIMIT))
  }
  let start = Date.now()
  const profiles = await clickhouse.rawRequest(sqlReq.toString() + ' FORMAT RowBinary',
    null,
    DATABASE_NAME(),
    {
      responseType: 'arraybuffer'
    })
  const binData = Uint8Array.from(profiles.data)
  req.log.debug(`selectMergeStacktraces: profiles downloaded: ${binData.length / 1025}kB in ${Date.now() - start}ms`)
  start = Date.now()
  require('./pprof-bin/pkg/pprof_bin').init_panic_hook()
  const promises = []
  const _ctxIdx = ++ctxIdx
  let mergeTreeLat = BigInt(0)
  let exportTreeLat = BigInt(0)
  for (let i = 0; i < binData.length;) {
    const [size, shift] = readULeb32(binData, i)
    const uarray = Uint8Array.from(profiles.data.slice(i + shift, i + size + shift))
    i += size + shift
    promises.push(new Promise((resolve, reject) => setTimeout(() => {
      try {
        const start = process.hrtime?.bigint ? process.hrtime.bigint() : 0
        pprofBin.merge_tree(_ctxIdx, uarray, `${typeRegex.sampleType}:${typeRegex.sampleUnit}`)
        mergeTreeLat += (process.hrtime?.bigint ? process.hrtime.bigint() : 0) - start
        resolve()
      } catch (e) {
        reject(e)
      }
    }, 0)))
  }
  let sResp = null
  try {
    await Promise.all(promises)
    const start = process.hrtime?.bigint ? process.hrtime.bigint() : 0
    sResp = pprofBin.export_tree(_ctxIdx, `${typeRegex.sampleType}:${typeRegex.sampleUnit}`)
    exportTreeLat += (process.hrtime?.bigint ? process.hrtime.bigint() : 0) - start
  } finally {
    req.log.debug(`selectMergeStacktraces: profiles processed: ${promises.length} in ${Date.now() - start}ms`)
    req.log.debug(`selectMergeStacktraces: mergeTree: ${mergeTreeLat / BigInt(1000000)}ms`)
    req.log.debug(`selectMergeStacktraces: export_tree: ${exportTreeLat / BigInt(1000000)}ms`)
    try { pprofBin.drop_tree(_ctxIdx) } catch (e) { req.log.error(e) }
  }
  return res.code(200).send(Buffer.from(sResp))
}

const selectMergeStacktracesV2 = async (req, res) => {

  const dist = clusterName ? '_dist' : ''
  const typeRegex = parseTypeId(req.body.getProfileTypeid())
  const sel = req.body.getLabelSelector()
  const fromTimeSec = req.body && req.body.getStart()
    ? Math.floor(parseInt(req.body.getStart()) / 1000)
    : Math.floor((Date.now() - 1000 * 60 * 60 * 48) / 1000)
  const toTimeSec = req.body && req.body.getEnd()
    ? Math.floor(parseInt(req.body.getEnd()) / 1000)
    : Math.floor(Date.now() / 1000)
  const idxSelect = (new Sql.Select())
    .select('fingerprint')
    .from(`${DATABASE_NAME()}.profiles_series_gin`)
    .where(
      Sql.And(
        Sql.Eq(new Sql.Raw(`has(sample_types_units, (${Sql.quoteVal(typeRegex.sampleType)},${Sql.quoteVal(typeRegex.sampleUnit)}))`), 1),
        Sql.Eq('type_id', Sql.val(`${typeRegex.type}:${typeRegex.periodType}:${typeRegex.periodUnit}`)),
        Sql.Gte('date', new Sql.Raw(`toDate(FROM_UNIXTIME(${Math.floor(fromTimeSec)}))`)),
        Sql.Lte('date', new Sql.Raw(`toDate(FROM_UNIXTIME(${Math.floor(toTimeSec)}))`))
      )
    ).groupBy('fingerprint')
  labelSelectorQuery(idxSelect, sel)
  const rawReq = (new Sql.Select())
    .select([
      new Sql.Raw(`arrayMap(x -> (x.1, x.2, x.3, (arrayFirst(y -> y.1 == ${Sql.quoteVal(`${typeRegex.sampleType}:${typeRegex.sampleUnit}`)}, x.4) as af).2, af.3), tree)`),
      'tree'
    ], 'functions')
    .from(`${DATABASE_NAME()}.profiles${dist}`)
    .where(
      Sql.And(
        Sql.Gte('timestamp_ns', new Sql.Raw(Math.floor(fromTimeSec) + '000000000')),
        Sql.Lte('timestamp_ns', new Sql.Raw(Math.floor(toTimeSec) + '000000000')),
        new Sql.In('fingerprint', 'IN', idxSelect)
      ))
  if (process.env.ADVANCED_PROFILES_MERGE_LIMIT) {
    rawReq.orderBy(['timestamp_ns', 'desc']).limit(parseInt(process.env.ADVANCED_PROFILES_MERGE_LIMIT))
  }
  const withRawReq = new Sql.With('raw', rawReq, !!clusterName)
  const joinedReq = (new Sql.Select()).with(withRawReq).select([
    new Sql.Raw('(raw.tree.1, raw.tree.2, raw.tree.3, sum(raw.tree.4), sum(raw.tree.5))'),
    'tree2'
  ]).from(new Sql.WithReference(withRawReq))
    .join('raw.tree', 'array')
    .groupBy(new Sql.Raw('raw.tree.1'), new Sql.Raw('raw.tree.2'), new Sql.Raw('raw.tree.3'))
  const withJoinedReq = new Sql.With('joined', joinedReq, !!clusterName)
  const joinedAggregatedReq = (new Sql.Select()).select(
    [new Sql.Raw('groupArray(tree2)'), 'tree']).from(new Sql.WithReference(withJoinedReq))
  //const withJoinedAggregatedReq = new Sql.With('joinedAggregated', joinedAggregatedReq, !!clusterName)
  const functionsReq = (new Sql.Select()).select(
    [new Sql.Raw('groupUniqArray(raw.functions)'), 'functions2']
  ).from(new Sql.WithReference(withRawReq)).join('raw.functions', 'array')
  //const withFunctionsReq = new Sql.With('functions', functionsReq, !!clusterName)

  const brack1 = new Sql.Raw(`(${joinedAggregatedReq.toString()})`)
  const brack2 = new Sql.Raw(`(${functionsReq.toString()})`)

  const sqlReq = (new Sql.Select())
    .with(withJoinedReq, withRawReq)
    .select(
      [brack2, 'functions'],
      [brack1, 'tree']
    )

  let start = Date.now()
  console.log(sqlReq.toString())
  const profiles = await clickhouse.rawRequest(sqlReq.toString() + ' FORMAT RowBinary',
    null,
    DATABASE_NAME(),
    {
      responseType: 'arraybuffer'
    })
  const binData = Uint8Array.from(profiles.data)
  require('fs').writeFileSync('test.dat', binData)
  req.log.debug(`selectMergeStacktraces: profiles downloaded: ${binData.length / 1025}kB in ${Date.now() - start}ms`)
  //start = Date.now()
  require('./pprof-bin/pkg/pprof_bin').init_panic_hook()
  start = process.hrtime?.bigint ? process.hrtime.bigint() : 0
  const resp = pprofBin.tree2Bin(binData)
  const exportTreeLat = (process.hrtime?.bigint ? process.hrtime.bigint() : 0) - start
  req.log.debug(`export_tree: ${exportTreeLat / BigInt(1000000)}ms`)
  return res.code(200).send(Buffer.from(resp))
  /*const promises = []
  const _ctxIdx = ++ctxIdx
  let mergeTreeLat = BigInt(0)
  let exportTreeLat = BigInt(0)
  for (let i = 0; i < binData.length;) {
    const [size, shift] = readULeb32(binData, i)
    const uarray = Uint8Array.from(profiles.data.slice(i + shift, i + size + shift))
    i += size + shift
    promises.push(new Promise((resolve, reject) => setTimeout(() => {
      try {
        const start = process.hrtime?.bigint ? process.hrtime.bigint() : 0
        pprofBin.merge_tree(_ctxIdx, uarray, `${typeRegex.sampleType}:${typeRegex.sampleUnit}`)
        mergeTreeLat += (process.hrtime?.bigint ? process.hrtime.bigint() : 0) - start
        resolve()
      } catch (e) {
        reject(e)
      }
    }, 0)))
  }
  let sResp = null
  try {
    await Promise.all(promises)
    const start = process.hrtime?.bigint ? process.hrtime.bigint() : 0
    sResp = pprofBin.export_tree(_ctxIdx, `${typeRegex.sampleType}:${typeRegex.sampleUnit}`)
    exportTreeLat += (process.hrtime?.bigint ? process.hrtime.bigint() : 0) - start
  } finally {
    req.log.debug(`selectMergeStacktraces: profiles processed: ${promises.length} in ${Date.now() - start}ms`)
    req.log.debug(`selectMergeStacktraces: mergeTree: ${mergeTreeLat / BigInt(1000000)}ms`)
    req.log.debug(`selectMergeStacktraces: export_tree: ${exportTreeLat / BigInt(1000000)}ms`)
    try { pprofBin.drop_tree(_ctxIdx) } catch (e) { req.log.error(e) }
  }
  return res.code(200).send(Buffer.from(sResp))*/
}

const selectSeries = async (req, res) => {
  const _req = req.body
  const fromTimeSec = Math.floor(req.getStart && req.getStart()
    ? parseInt(req.getStart()) / 1000
    : Date.now() / 1000 - HISTORY_TIMESPAN)
  const toTimeSec = Math.floor(req.getEnd && req.getEnd()
    ? parseInt(req.getEnd()) / 1000
    : Date.now() / 1000)
  let typeID = _req.getProfileTypeid && _req.getProfileTypeid()
  if (!typeID) {
    throw new QrynBadRequest('No type provided')
  }
  typeID = parseTypeId(typeID)
  if (!typeID) {
    throw new QrynBadRequest('Invalid type provided')
  }
  const dist = clusterName ? '_dist' : ''
  const sampleTypeId = typeID.sampleType + ':' + typeID.sampleUnit
  const labelSelector = _req.getLabelSelector && _req.getLabelSelector()
  let groupBy = _req.getGroupByList && _req.getGroupByList()
  groupBy = groupBy && groupBy.length ? groupBy : null
  const step = _req.getStep && parseInt(_req.getStep())
  if (!step || isNaN(step)) {
    throw new QrynBadRequest('No step provided')
  }
  const aggregation = _req.getAggregation && _req.getAggregation()

  const idxReq = (new Sql.Select())
    .select(new Sql.Raw('fingerprint'))
    .from(`${DATABASE_NAME()}.profiles_series_gin`)
    .where(
      Sql.And(
        Sql.Eq('type_id', Sql.val(`${typeID.type}:${typeID.periodType}:${typeID.periodUnit}`)),
        Sql.Gte('date', new Sql.Raw(`toDate(FROM_UNIXTIME(${Math.floor(fromTimeSec)}))`)),
        Sql.Lte('date', new Sql.Raw(`toDate(FROM_UNIXTIME(${Math.floor(toTimeSec)}))`)),
        Sql.Eq(new Sql.Raw(
          `has(sample_types_units, (${Sql.quoteVal(typeID.sampleType)}, ${Sql.quoteVal(typeID.sampleUnit)}))`),
        1)
      )
    )
  labelSelectorQuery(idxReq, labelSelector)

  const withIdxReq = (new Sql.With('idx', idxReq, !!clusterName))

  let tagsReq = 'arraySort(p.tags)'
  if (groupBy) {
    tagsReq = `arraySort(arrayFilter(x -> x.1 in (${groupBy.map(g => Sql.quoteVal(g)).join(',')}), p.tags))`
  }

  const labelsReq = (new Sql.Select()).with(withIdxReq).select(
    'fingerprint',
    [new Sql.Raw(tagsReq), 'tags'],
    [groupBy ? 'fingerprint' : new Sql.Raw('cityHash64(tags)'), 'new_fingerprint']
  ).distinct(true).from([`${DATABASE_NAME()}.profiles_series`, 'p'])
    .where(Sql.And(
      new Sql.In('fingerprint', 'IN', new Sql.WithReference(withIdxReq)),
      Sql.Gte('date', new Sql.Raw(`toDate(FROM_UNIXTIME(${Math.floor(fromTimeSec)}))`)),
      Sql.Lte('date', new Sql.Raw(`toDate(FROM_UNIXTIME(${Math.floor(toTimeSec)}))`))
    ))

  const withLabelsReq = new Sql.With('labels', labelsReq, !!clusterName)

  let valueCol = new Sql.Raw(
    `sum(toFloat64(arrayFirst(x -> x.1 == ${Sql.quoteVal(sampleTypeId)}, p.values_agg).2))`)
  if (aggregation === types.TimeSeriesAggregationType.TIME_SERIES_AGGREGATION_TYPE_AVERAGE) {
    valueCol = new Sql.Raw(
      `sum(toFloat64(arrayFirst(x -> x.1 == ${Sql.quoteVal(sampleTypeId)}).2, p.values_agg)) / ` +
      `sum(toFloat64(arrayFirst(x -> x.1 == ${Sql.quoteVal(sampleTypeId)}).3, p.values_agg))`
    )
  }

  const mainReq = (new Sql.Select()).with(withIdxReq, withLabelsReq).select(
    [new Sql.Raw(`intDiv(p.timestamp_ns, 1000000000 * ${step}) * ${step} * 1000`), 'timestamp_ms'],
    [new Sql.Raw('labels.new_fingerprint'), 'fingerprint'],
    [new Sql.Raw('min(labels.tags)'), 'labels'],
    [valueCol, 'value']
  ).from([`${DATABASE_NAME()}.profiles${dist}`, 'p']).join(
    [new Sql.WithReference(withLabelsReq), 'labels'],
    'ANY LEFT',
    Sql.Eq(new Sql.Raw('p.fingerprint'), new Sql.Raw('labels.fingerprint'))
  ).where(
    Sql.And(
      new Sql.In('p.fingerprint', 'IN', new Sql.WithReference(withIdxReq)),
      Sql.Gte('p.timestamp_ns', new Sql.Raw(`${fromTimeSec}000000000`)),
      Sql.Lt('p.timestamp_ns', new Sql.Raw(`${toTimeSec}000000000`))
    )
  ).groupBy('timestamp_ns', 'fingerprint')
    .orderBy(['fingerprint', 'ASC'], ['timestamp_ns', 'ASC'])
  const strMainReq = mainReq.toString()
  console.log(strMainReq)
  const chRes = await clickhouse
    .rawRequest(strMainReq + ' FORMAT JSON', null, DATABASE_NAME())

  let lastFingerprint = null
  const seriesList = []
  let lastSeries = null
  let lastPoints = []
  for (let i = 0; i < chRes.data.data.length; i++) {
    const e = chRes.data.data[i]
    if (lastFingerprint !== e.fingerprint) {
      lastFingerprint = e.fingerprint
      lastSeries && lastSeries.setPointsList(lastPoints)
      lastSeries && seriesList.push(lastSeries)
      lastPoints = []
      lastSeries = new types.Series()
      lastSeries.setLabelsList(e.labels.map(l => {
        const lp = new types.LabelPair()
        lp.setName(l[0])
        lp.setValue(l[1])
        return lp
      }))
    }

    const p = new types.Point()
    p.setValue(e.value)
    p.setTimestamp(e.timestamp_ms)
    lastPoints.push(p)
  }
  lastSeries && lastSeries.setPointsList(lastPoints)
  lastSeries && seriesList.push(lastSeries)

  const resp = new messages.SelectSeriesResponse()
  resp.setSeriesList(seriesList)
  return res.code(200).send(Buffer.from(resp.serializeBinary()))
}

module.exports.init = (fastify) => {
  const fns = {
    profileTypes: profileTypesHandler,
    labelNames: labelNames,
    labelValues: labelValues,
    selectMergeStacktraces: selectMergeStacktraces,
    selectSeries: selectSeries
  }
  for (const name of Object.keys(fns)) {
    fastify.post(services.QuerierServiceService[name].path, (req, res) => {
      return fns[name](req, res)
    }, {
      '*': parser(services.QuerierServiceService[name].requestType)
    })
  }
}
