import React, {useEffect, useRef, useState} from "react"
import {Button, Checkbox, Col, Divider, Form, Input, Row, Space, Spin, Tabs, Tag, Upload} from "antd"
import {InputInteger, InputItem, SelectOne, SwitchItem} from "../../utils/inputUtil"
import {randomString} from "../../utils/randomUtil"
import {ExecResult, YakScript} from "../invoker/schema"
import {failed, info} from "../../utils/notification"
import {XTerm} from "xterm-for-react"
import {writeExecResultXTerm, xtermClear, xtermFit} from "../../utils/xtermUtils"
import {OpenPortTableViewer} from "./PortTable"
import {ExtractExecResultMessageToYakitPort, YakitPort} from "../../components/yakitLogSchema"
import {PortAssetTable} from "../assetViewer/PortAssetPage"
import {PortAsset} from "../assetViewer/models"
import {PresetPorts} from "./schema"
import {useGetState, useMemoizedFn} from "ahooks"
import {queryYakScriptList} from "../yakitStore/network"
import {PluginList} from "../../components/PluginList"
import {showModal} from "../../utils/showModal"
import {PluginResultUI} from "../yakitStore/viewers/base"
import useHoldingIPCRStream from "../../hook/useHoldingIPCRStream"

import "./PortScanPage.css"

const {ipcRenderer} = window.require("electron")

export interface PortScanPageProp {
}

export interface PortScanParams {
    Targets: string
    Ports: string
    Mode: "syn" | "fingerprint" | "all"
    Proto: ("tcp" | "udp")[]
    Concurrent: number
    Active: boolean
    FingerprintMode: "service" | "web" | "all"
    SaveToDB: boolean
    SaveClosedPorts: boolean
    TargetsFile?: string
    ScriptNames: string[]
}

const ScanKind: { [key: string]: string } = {
    syn: "SYN",
    fingerprint: "指纹",
    all: "SYN+指纹"
}
const ScanKindKeys: string[] = Object.keys(ScanKind)

export const PortScanPage: React.FC<PortScanPageProp> = (props) => {
    const [scripts, setScripts, getScripts] = useGetState<YakScript[]>([])
    const [total, setTotal] = useState(0)
    const [pluginLoading, setPluginLoading] = useState<boolean>(false)

    const [params, setParams] = useState<PortScanParams>({
        Ports: "22,443,445,80,8000-8004,3306,3389,5432,8080-8084,7000-7005",
        Mode: "fingerprint",
        Targets: "",
        Active: true,
        Concurrent: 50,
        FingerprintMode: "all",
        Proto: ["tcp"],
        SaveClosedPorts: false,
        SaveToDB: true,
        ScriptNames: []
    })
    const [loading, setLoading] = useState(false)
    const [token, setToken] = useState(randomString(40))
    const [resettingData, setResettingData] = useState(false)
    const xtermRef = useRef(null)
    const [resetTrigger, setResetTrigger] = useState(false)
    const [openPorts, setOpenPorts] = useState<YakitPort[]>([])
    const [closedPorts, setClosedPorts] = useState<YakitPort[]>([])
    const [port, setPort] = useState<PortAsset>()

    const [uploadLoading, setUploadLoading] = useState(false)

    const openPort = useRef<YakitPort[]>([])
    const closedPort = useRef<YakitPort[]>([])

    const [infoState, {reset}] = useHoldingIPCRStream(
        "scan-port",
        "PortScan",
        token,
        () => {
        },
        () => {
        },
        (obj, content) => content.data.indexOf("isOpen") > -1 && content.data.indexOf("port") > -1
    )

    const search = useMemoizedFn((params?: { limit: number; keyword: string }) => {
        const {limit, keyword} = params || {}

        setPluginLoading(true)
        queryYakScriptList(
            "port-scan",
            (data, total) => {
                setTotal(total || 0)
                setScripts(data)
            },
            () => setTimeout(() => setPluginLoading(false), 300),
            limit || 200,
            undefined,
            keyword || ""
        )
    })
    const allSelectYakScript = useMemoizedFn((flag: boolean) => {
        if (flag) {
            const newSelected = [...scripts.map((i) => i.ScriptName), ...params.ScriptNames]
            setParams({...params, ScriptNames: newSelected.filter((e, index) => newSelected.indexOf(e) === index)})
        } else {
            setParams({...params, ScriptNames: []})
        }
    })
    const selectYakScript = useMemoizedFn((y: YakScript) => {
        if (!params.ScriptNames.includes(y.ScriptName))
            setParams({...params, ScriptNames: [...params.ScriptNames, y.ScriptName]})
    })
    const unselectYakScript = useMemoizedFn((y: YakScript) => {
        setParams({...params, ScriptNames: params.ScriptNames.filter((i) => i !== y.ScriptName)})
    })

    useEffect(() => {
        search()
    }, [])

    useEffect(() => {
        if (xtermRef) xtermFit(xtermRef, 128, 10)
    })

    useEffect(() => {
        if (!xtermRef) {
            return
        }

        ipcRenderer.on(`${token}-data`, async (e: any, data: ExecResult) => {
            if (data.IsMessage) {
                try {
                    let messageJsonRaw = Buffer.from(data.Message).toString("utf8")
                    let logInfo = ExtractExecResultMessageToYakitPort(JSON.parse(messageJsonRaw))
                    if (!logInfo) return

                    if (logInfo.isOpen) openPort.current.unshift(logInfo)
                    else closedPort.current.unshift(logInfo)
                } catch (e) {
                    failed("解析端口扫描结果失败...")
                }
            }
            writeExecResultXTerm(xtermRef, data)
        })
        ipcRenderer.on(`${token}-error`, (e: any, error: any) => {
            failed(`[PortScan] error:  ${error}`)
        })
        ipcRenderer.on(`${token}-end`, (e: any, data: any) => {
            info("[PortScan] finished")
            setLoading(false)
        })

        const syncPorts = () => {
            if (openPort.current) setOpenPorts([...openPort.current])
            if (closedPort.current) setClosedPorts([...closedPort.current])
        }
        let id = setInterval(syncPorts, 1000)
        return () => {
            clearInterval(id)
            ipcRenderer.invoke("cancel-PortScan", token)
            ipcRenderer.removeAllListeners(`${token}-data`)
            ipcRenderer.removeAllListeners(`${token}-error`)
            ipcRenderer.removeAllListeners(`${token}-end`)
        }
    }, [xtermRef, resetTrigger])

    return (
        <div style={{width: "100%", height: "100%"}}>
            <Tabs className='scan-port-tabs' tabBarStyle={{marginBottom: 5}}>
                <Tabs.TabPane tab={"扫描端口操作台"} key={"scan"}>
                    <div className='scan-port-body'>
                        <div style={{width: 360, height: "100%"}}>
                            <PluginList
                                loading={loading}
                                lists={scripts}
                                getLists={getScripts}
                                total={total}
                                selected={params.ScriptNames}
                                allSelectScript={allSelectYakScript}
                                selectScript={selectYakScript}
                                unSelectScript={unselectYakScript}
                                search={search}
                                title={"端口扫描插件"}
                                bodyStyle={{
                                    padding: "0 4px",
                                    overflow: "hidden"
                                }}
                            ></PluginList>
                        </div>

                        <div className='right-container'>
                            <div style={{width: "100%"}}>
                                <Form
                                    labelAlign='right'
                                    labelCol={{span: 5}}
                                    onSubmitCapture={(e) => {
                                        e.preventDefault()

                                        if (!token) {
                                            failed("No Token Assigned")
                                            return
                                        }
                                        if (!params.Targets && !params.TargetsFile) {
                                            failed("需要设置扫描目标")
                                            return
                                        }

                                        setLoading(true)
                                        openPort.current = []
                                        closedPort.current = []
                                        reset()
                                        xtermClear(xtermRef)
                                        ipcRenderer.invoke("PortScan", params, token)
                                    }}
                                >
                                    <Upload.Dragger
                                        className='targets-upload-dragger'
                                        accept={"text/plain"}
                                        multiple={false}
                                        maxCount={1}
                                        showUploadList={false}
                                        beforeUpload={(f) => {
                                            if (f.type !== "text/plain") {
                                                failed(`${f.name}非txt文件，请上传txt格式文件！`)
                                                return false
                                            }

                                            setUploadLoading(true)
                                            ipcRenderer.invoke("fetch-file-content", (f as any).path).then((res) => {
                                                setParams({...params, Targets: res})
                                                setTimeout(() => setUploadLoading(false), 100)
                                            })
                                            return false
                                        }}
                                    >
                                        <Spin spinning={uploadLoading}>
                                            <InputItem
                                                style={{textAlign: "left"}}
                                                width={"75%"}
                                                label={"扫描目标"}
                                                setValue={(Targets) => setParams({...params, Targets})}
                                                value={params.Targets}
                                                textarea={true}
                                                textareaRow={1}
                                                isBubbing={true}
                                                placeholder='域名/主机/IP/IP段均可，逗号分隔或按行分割'
                                                help={
                                                    <div>
                                                        可将TXT文件拖入框内或
                                                        <span style={{color: "rgb(25,143,255)"}}>点击此处</span>上传
                                                    </div>
                                                }
                                                suffixNode={
                                                    loading ? (
                                                        <Button
                                                            className='form-submit-style'
                                                            type='primary'
                                                            danger
                                                            onClick={(e) => {
                                                                ipcRenderer.invoke("cancel-PortScan", token)
                                                                e.stopPropagation()
                                                            }}
                                                        >
                                                            停止扫描
                                                        </Button>
                                                    ) : (
                                                        <Button
                                                            className='form-submit-style'
                                                            type='primary'
                                                            htmlType='submit'
                                                            onClick={(e) => e.stopPropagation()}
                                                        >
                                                            开始扫描
                                                        </Button>
                                                    )
                                                }
                                            />
                                        </Spin>
                                    </Upload.Dragger>

                                    <Form.Item label='预设端口' colon={false} className='form-item-margin'>
                                        <Checkbox.Group
                                            onChange={(value) => {
                                                let res: string = (value || [])
                                                    .map((i) => {
                                                        // @ts-ignore
                                                        return PresetPorts[i] || ""
                                                    })
                                                    .join(",")
                                                setParams({...params, Ports: res})
                                            }}
                                        >
                                            <Checkbox value={"top100"}>常见100端口</Checkbox>
                                            <Checkbox value={"topweb"}>常见 Web 端口</Checkbox>
                                            <Checkbox value={"top1000+"}>常见一两千</Checkbox>
                                            <Checkbox value={"topdb"}>常见数据库与 MQ</Checkbox>
                                            <Checkbox value={"topudp"}>常见 UDP 端口</Checkbox>
                                        </Checkbox.Group>
                                    </Form.Item>

                                    <Form.Item label='扫描端口' colon={false} className='form-item-margin'>
                                        <Input.TextArea
                                            style={{width: "75%"}}
                                            rows={1}
                                            value={params.Ports}
                                            onChange={(e) => setParams({...params, Ports: e.target.value})}
                                        ></Input.TextArea>
                                    </Form.Item>

                                    <Form.Item label=' ' colon={false} className='form-item-margin'>
                                        <Space>
                                            <Tag>扫描模式:{ScanKind[params.Mode]}</Tag>
                                            <Tag>并发:{params.Concurrent}</Tag>
                                            <Button
                                                type='link'
                                                size='small'
                                                onClick={() => {
                                                    showModal({
                                                        title: "设置高级参数",
                                                        width: "50%",
                                                        content: (
                                                            <>
                                                                <ScanPortForm
                                                                    defaultParams={params}
                                                                    setParams={setParams}
                                                                />
                                                            </>
                                                        )
                                                    })
                                                }}
                                            >
                                                更多参数
                                            </Button>
                                        </Space>
                                    </Form.Item>
                                </Form>
                            </div>
                            <Divider style={{margin: "5px 0"}}/>
                            <div style={{flex: 1, overflow: "hidden"}}>
                                <Tabs className='scan-port-tabs' tabBarStyle={{marginBottom: 5}}>
                                    <Tabs.TabPane tab={"扫描端口列表"} key={"scanPort"} forceRender>
                                        <div style={{width: "100%", height: "100%", overflow: "hidden auto"}}>
                                            <div style={{textAlign: "right", marginBottom: 8}}>
                                                {loading ? (
                                                    <Tag color={"green"}>正在执行...</Tag>
                                                ) : (
                                                    <Tag>闲置中...</Tag>
                                                )}
                                                <Button
                                                    disabled={resettingData || loading}
                                                    size={"small"}
                                                    onClick={(e) => {
                                                        xtermClear(xtermRef)
                                                        openPort.current = []
                                                        closedPort.current = []
                                                        reset()
                                                        setResettingData(true)
                                                        setResetTrigger(!resetTrigger)
                                                        setTimeout(() => {
                                                            setResettingData(false)
                                                        }, 1200)
                                                    }}
                                                    type={"link"}
                                                    danger={true}
                                                >
                                                    清空缓存结果
                                                </Button>
                                            </div>

                                            <div style={{width: "100%", overflow: "auto"}}>
                                                <XTerm
                                                    ref={xtermRef}
                                                    options={{
                                                        convertEol: true,
                                                        disableStdin: true
                                                    }}
                                                    onResize={(r) => xtermFit(xtermRef, r.cols, 10)}
                                                />
                                            </div>

                                            <Spin spinning={resettingData}>
                                                <Row style={{marginTop: 6}} gutter={6}>
                                                    <Col span={24}>
                                                        <OpenPortTableViewer data={openPorts}/>
                                                    </Col>
                                                    {/*<Col span={8}>*/}
                                                    {/*    <ClosedPortTableViewer data={closedPorts}/>*/}
                                                    {/*</Col>*/}
                                                </Row>
                                            </Spin>
                                        </div>
                                    </Tabs.TabPane>
                                    <Tabs.TabPane tab={"插件日志"} key={"pluginPort"} forceRender>
                                        <div style={{width: "100%", height: "100%", overflow: "hidden auto"}}>
                                            <PluginResultUI
                                                loading={loading}
                                                progress={infoState.processState}
                                                results={infoState.messageSate}
                                                feature={infoState.featureMessageState}
                                                statusCards={infoState.statusState}
                                            />
                                        </div>
                                    </Tabs.TabPane>
                                </Tabs>
                            </div>
                        </div>
                    </div>
                </Tabs.TabPane>
                <Tabs.TabPane tab={"端口资产管理"} key={"port"}>
                    <Row gutter={12}>
                        <Col span={24}>
                            <PortAssetTable
                                onClicked={(i) => {
                                    setPort(i)
                                }}
                            />
                        </Col>
                        {/* <Col span={8}>
                        {port ? <PortAssetDescription port={port}/> : <Empty>
                            点击端口列表查看内容
                        </Empty>}
                    </Col> */}
                    </Row>
                </Tabs.TabPane>
            </Tabs>
        </div>
    )
}

interface ScanPortFormProp {
    defaultParams: PortScanParams
    setParams: (p: PortScanParams) => any
}

const ScanPortForm: React.FC<ScanPortFormProp> = (props) => {
    const [params, setParams] = useState<PortScanParams>(props.defaultParams)

    useEffect(() => {
        if (!params) return
        props.setParams({...params})
    }, [params])

    return (
        <Form
            onSubmitCapture={(e) => {
                e.preventDefault()
            }}
            labelCol={{span: 5}}
            wrapperCol={{span: 14}}
        >
            <SelectOne
                label={"扫描模式"}
                data={ScanKindKeys.map((item) => {
                    return {value: item, text: ScanKind[item]}
                })}
                help={"SYN 扫描需要 yak 启动时具有root"}
                setValue={(Mode) => setParams({...params, Mode})}
                value={params.Mode}
            />
            <InputInteger
                label={"并发"}
                help={"最多同时扫描200个端口"}
                value={params.Concurrent}
                min={1}
                max={200}
                setValue={(e) => setParams({...params, Concurrent: e})}
            />
            <SwitchItem
                label={"主动模式"}
                help={"允许指纹探测主动发包"}
                setValue={(Active) => setParams({...params, Active})}
                value={params.Active}
            />
            <SwitchItem
                label={"扫描结果入库"}
                setValue={(SaveToDB) => {
                    setParams({...params, SaveToDB, SaveClosedPorts: false})
                }}
                value={params.SaveToDB}
            />
            {params.SaveToDB && (
                <SwitchItem
                    label={"保存关闭的端口"}
                    setValue={(SaveClosedPorts) => setParams({...params, SaveClosedPorts})}
                    value={params.SaveClosedPorts}
                />
            )}
            {params.Mode !== "syn" && (
                <SelectOne
                    label={"高级指纹选项"}
                    data={[
                        {value: "web", text: "仅web指纹"},
                        {value: "service", text: "仅nmap指纹"},
                        {value: "all", text: "全部指纹"}
                    ]}
                    setValue={(FingerprintMode) => setParams({...params, FingerprintMode})}
                    value={params.FingerprintMode}
                />
            )}
        </Form>
    )
}
