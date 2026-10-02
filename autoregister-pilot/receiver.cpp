#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstring>
#include <ctime>
#include <dlfcn.h>
#include <filesystem>
#include <iostream>
#include <mutex>
#include <regex>
#include <stdexcept>
#include <string>
#include <termios.h>
#include <unistd.h>
#include "dhnetsdk.h"

// Single-DVR homologation tool. Use the matching Linux64 SDK header/libs.
namespace {
std::atomic<bool> cancelled{false}, disconnected{false};
std::atomic<int> progress{0};
std::mutex registrationMutex;
std::condition_variable registrationChanged;
std::string expectedId, registeredIp;
WORD registeredPort=0;
bool registered=false;
void signalHandler(int) { cancelled=true; }
void onDisconnect(LLONG, char*, LONG, LDWORD) { disconnected=true; }
int onRegister(LLONG, char* ip, WORD port, LONG command, void* param, DWORD length, LDWORD) {
    // Do not parse binary/token events as C strings or attempt unsolicited logins.
    if(command!=DH_DVR_SERIAL_RETURN || !param || !ip || !length || length>256) return 0;
    const char* value=static_cast<const char*>(param);
    const size_t size=strnlen(value,length);
    if(std::string(value,size)!=expectedId) return 0;
    std::lock_guard<std::mutex> lock(registrationMutex);
    if(!registered) { registeredIp=ip; registeredPort=port; registered=true; registrationChanged.notify_one(); }
    return 0;
}
void onDownload(LLONG, DWORD, DWORD downloaded, int, NET_RECORDFILE_INFO, LDWORD) {
    if(downloaded==static_cast<DWORD>(-1)) progress=1;
    else if(downloaded==static_cast<DWORD>(-2)) progress=-1;
}
template<class T> T symbol(void* lib,const char* name) {
    dlerror(); void* p=dlsym(lib,name); const char* error=dlerror();
    if(error) throw std::runtime_error(std::string("SDK sem funcao ")+name);
    return reinterpret_cast<T>(p);
}
NET_TIME parseTime(const std::string& text) {
    std::smatch match;
    if(!std::regex_match(text,match,std::regex("([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})")))
        throw std::runtime_error("Horario deve usar YYYY-MM-DDTHH:MM:SS, no relogio local do DVR.");
    NET_TIME t{}; t.dwYear=std::stoi(match[1]); t.dwMonth=std::stoi(match[2]); t.dwDay=std::stoi(match[3]);
    t.dwHour=std::stoi(match[4]); t.dwMinute=std::stoi(match[5]); t.dwSecond=std::stoi(match[6]);
    const bool leap=t.dwYear%4==0 && (t.dwYear%100!=0 || t.dwYear%400==0);
    const unsigned days[]={0,31,static_cast<unsigned>(leap?29:28),31,30,31,30,31,31,30,31,30,31};
    if(t.dwYear<2000 || t.dwYear>2100 || t.dwMonth<1 || t.dwMonth>12 || t.dwDay<1 || t.dwDay>days[t.dwMonth]
       || t.dwHour>23 || t.dwMinute>59 || t.dwSecond>59) throw std::runtime_error("Data/hora invalida.");
    return t;
}
time_t calendarSeconds(const NET_TIME& t) {
    tm v{}; v.tm_year=t.dwYear-1900; v.tm_mon=t.dwMonth-1; v.tm_mday=t.dwDay;
    v.tm_hour=t.dwHour; v.tm_min=t.dwMinute; v.tm_sec=t.dwSecond;
    return timegm(&v); // Only for interval validation; SDK receives original DVR-local values.
}
std::string password() {
    if(!isatty(STDIN_FILENO)) { std::string s; std::getline(std::cin,s); return s; }
    termios old{},hidden{};
    if(tcgetattr(STDIN_FILENO,&old)!=0) throw std::runtime_error("Nao foi possivel proteger a senha no terminal.");
    hidden=old; hidden.c_lflag&=~ECHO;
    if(tcsetattr(STDIN_FILENO,TCSAFLUSH,&hidden)!=0) throw std::runtime_error("Nao foi possivel proteger a senha.");
    std::cerr<<"Senha do DVR (oculta): "; std::string s; std::getline(std::cin,s);
    tcsetattr(STDIN_FILENO,TCSAFLUSH,&old); std::cerr<<"\n"; return s;
}
}
int main(int argc,char** argv) {
    if(argc!=10) {
        std::cerr<<"Uso: receiver SDK_SO BIND PORT ID USER CHANNEL START END OUTPUT.dav\n"
                 <<"Canal: numero exibido no DVR (1..N). Datas: YYYY-MM-DDTHH:MM:SS.\n";
        return 2;
    }
    void* library=nullptr; LLONG listener=0,login=0,download=0; bool initialized=false;
    decltype(&CLIENT_Cleanup) cleanup=nullptr;
    decltype(&CLIENT_StopListenServer) stopListen=nullptr;
    decltype(&CLIENT_Logout) logout=nullptr;
    decltype(&CLIENT_StopDownload) stopDownload=nullptr;
    int result=1;
    try {
        const int port=std::stoi(argv[3]),channel=std::stoi(argv[6]); expectedId=argv[4];
        if(port<1 || port>65535 || channel<1 || channel>256 || expectedId.empty() || expectedId.size()>128)
            throw std::runtime_error("Porta, canal ou ID invalido.");
        NET_TIME start=parseTime(argv[7]),end=parseTime(argv[8]);
        if(std::string(argv[8])<=argv[7]) throw std::runtime_error("Fim deve ser posterior ao inicio.");
        if(calendarSeconds(end)-calendarSeconds(start)>120) throw std::runtime_error("Piloto limitado a trechos de ate 120 segundos.");
        if(std::filesystem::exists(argv[9])) throw std::runtime_error("Arquivo de destino ja existe; escolha outro nome.");
        const std::filesystem::path output(argv[9]);
        std::string partial=std::string(argv[9])+".partial";
        if(std::filesystem::exists(partial)) throw std::runtime_error("Arquivo parcial ja existe; escolha outro nome.");
        if(!output.parent_path().empty()) std::filesystem::create_directories(output.parent_path());
        library=dlopen(argv[1],RTLD_NOW|RTLD_GLOBAL);
        if(!library) throw std::runtime_error(std::string("Falha carregando SDK: ")+dlerror());
        auto init=symbol<decltype(&CLIENT_Init)>(library,"CLIENT_Init");
        cleanup=symbol<decltype(cleanup)>(library,"CLIENT_Cleanup");
        auto listen=symbol<decltype(&CLIENT_ListenServer)>(library,"CLIENT_ListenServer");
        stopListen=symbol<decltype(stopListen)>(library,"CLIENT_StopListenServer");
        auto loginEx=symbol<decltype(&CLIENT_LoginEx2)>(library,"CLIENT_LoginEx2");
        logout=symbol<decltype(logout)>(library,"CLIENT_Logout");
        auto downloadByTime=symbol<decltype(&CLIENT_DownloadByTimeEx)>(library,"CLIENT_DownloadByTimeEx");
        stopDownload=symbol<decltype(stopDownload)>(library,"CLIENT_StopDownload");
        auto lastError=symbol<decltype(&CLIENT_GetLastError)>(library,"CLIENT_GetLastError");
        if(!init(onDisconnect,0)) throw std::runtime_error("CLIENT_Init falhou.");
        initialized=true;
        std::string secret=password(); if(secret.empty()) throw std::runtime_error("Senha vazia.");
        std::signal(SIGINT,signalHandler); std::signal(SIGTERM,signalHandler);
        listener=listen(argv[2],static_cast<WORD>(port),1000,onRegister,0);
        if(!listener) throw std::runtime_error("Escuta falhou; erro SDK="+std::to_string(lastError()));
        std::cout<<"LISTENING port="<<port<<"; aguardando Cerejeiras (180s)."<<std::endl;
        const auto registrationDeadline=std::chrono::steady_clock::now()+std::chrono::seconds(180);
        {
            std::unique_lock<std::mutex> lock(registrationMutex);
            while(!registered && !cancelled && std::chrono::steady_clock::now()<registrationDeadline)
                registrationChanged.wait_for(lock,std::chrono::milliseconds(200));
            if(!registered || cancelled) throw std::runtime_error("Sem registro valido antes do prazo ou teste cancelado.");
        }
        std::cout<<"REGISTERED; autenticando pela conexao recebida."<<std::endl;
        NET_DEVICEINFO_Ex info{}; int error=0;
        login=loginEx(registeredIp.c_str(),registeredPort,argv[5],secret.c_str(),
                      EM_LOGIN_SPEC_CAP_SERVER_CONN,const_cast<char*>(expectedId.c_str()),&info,&error);
        std::fill(secret.begin(),secret.end(),'\0');
        if(!login) throw std::runtime_error("Login falhou; codigo="+std::to_string(error)+" SDK="+std::to_string(lastError()));
        if(channel>info.nChanNum) throw std::runtime_error("Canal solicitado excede canais reportados pelo DVR.");
        std::cout<<"AUTHENTICATED channels="<<static_cast<int>(info.nChanNum)<<std::endl;
        download=downloadByTime(login,channel-1,0,&start,&end,partial.data(),onDownload,0,nullptr,0,nullptr);
        if(!download) throw std::runtime_error("Download nao iniciou; SDK="+std::to_string(lastError()));
        const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(180);
        while(!progress && !cancelled && !disconnected && std::chrono::steady_clock::now()<deadline)
            usleep(100000);
        stopDownload(download); download=0;
        if(progress!=1 || cancelled || disconnected) throw std::runtime_error("Download incompleto, desconexao ou cancelamento; arquivo parcial nao validado.");
        if(!std::filesystem::exists(partial) || std::filesystem::file_size(partial)==0)
            throw std::runtime_error("SDK terminou mas retornou arquivo vazio.");
        std::filesystem::rename(partial,output);
        std::cout<<"DOWNLOAD_COMPLETE bytes="<<std::filesystem::file_size(output)<<std::endl;
        result=0;
    } catch(const std::exception& e) { std::cerr<<"TEST_FAILED: "<<e.what()<<std::endl; }
    if(download && stopDownload) stopDownload(download);
    if(login && logout) logout(login);
    if(listener && stopListen) stopListen(listener);
    if(initialized && cleanup) cleanup();
    if(library) dlclose(library);
    return result;
}
